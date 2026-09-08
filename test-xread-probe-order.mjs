/**
 * THE PROBE MUST NOT BE THE X READ.
 *
 * desk.js refuses to buy the xAI read while the Anthropic breaker is cooling down
 * (test-credit-guard-before-read.mjs). It has to let ONE outage case through — a probe is
 * due — because a real call is the only thing that closes a breaker. Whatever the desk
 * buys next IS that probe, and until this change it was the read itself: bought for every
 * screen survivor the instant the cooldown lapsed, before any Anthropic seat had been
 * asked whether the account pays. Live 24h: XRead 110 calls ($14.69) against Liquidity 31
 * — ~79 reads, ~$10.5, 28% of a $38.26 day, for coins no seat ever judged; over 7 days at
 * least 967 of 1,437 reads.
 *
 * The fix: while the breaker is not closed, the cheapest seat (Liquidity) goes first and
 * only its bill buys the read. The healthy order does not move — Grok second, straight
 * behind the free screen, as the owner set it on 2026-09-04 (test-xread-order.mjs pins
 * that at source level and must keep passing unchanged).
 *
 * WHAT IS REAL, so the assertions are about the code that ships: workup(), the free
 * screen, ask() and grokXRead() with their breaker gates, the breaker state machine, both
 * cost meters and the llm_spend ledger. WHAT IS STUBBED: the network (a counted fetch that
 * answers as each provider would — the order of what left the process IS the evidence),
 * gather() (one canned bundle the REAL screen is shown to pass), and writeReport (kept out
 * of the repo). Time is injected so a cooldown is crossed in microseconds.
 */
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const REPO = path.dirname(new URL(import.meta.url).pathname);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "xread-probe-"));
process.env.CLAUDE_CO_DB = process.env.CLAUDE_CO_DB || path.join(TMP, "probe.db");
process.env.EXECUTE = "0";
process.env.ANTHROPIC_API_KEY = "sk-ant-not-a-real-key-for-tests";
process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9/anthropic-must-not-be-reached";
process.env.XAI_API_KEY = "xai-not-a-real-key-for-tests";
process.env.XAI_BASE_URL = "http://127.0.0.1:9/xai-must-not-be-reached";

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ok   ${label}${detail ? `  — ${detail}` : ""}`); }
  else { fail += 1; console.log(`  FAIL ${label}${detail ? `  — ${detail}` : ""}`); }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ── the stub layer: gather() and the scribe, the way test-quota-simulation.mjs does it ── */
const F = (rel) => pathToFileURL(path.join(REPO, rel)).href;
const STUBBED = new Map([
  [F("src/data/evidence.js"), "evidence"],
  [F("src/report.js"), "report"],
]);
const SOURCE = {
  /* screen() and enrichWithXRead() stay REAL — only the network-bound gather() is canned. */
  evidence: `
    export * from "${F("src/data/evidence.js")}?probe=real";
    export async function gather(mint, hook) { return globalThis.__PROBE.gather(mint, hook); }
  `,
  report: `
    export * from "${F("src/report.js")}?probe=real";
    export function writeReport(cycle, r) {
      globalThis.__PROBE.reports.push({ cycle, symbol: r?.symbol, outcome: r?.outcome });
      return "reports/probe-test/" + String(cycle) + "__" + (r?.symbol || "x") + ".md";
    }
  `,
};
registerHooks({
  resolve(spec, ctx, next) {
    const r = next(spec, ctx);
    if (String(r.url).includes("probe=real")) return r;
    const key = STUBBED.get(String(r.url));
    if (!key) return r;
    return { ...r, url: `${r.url}?probe=stub&k=${key}`, format: "module", shortCircuit: true };
  },
  load(url, ctx, next) {
    const u = String(url);
    if (u.includes("probe=stub")) {
      const k = new URL(u).searchParams.get("k");
      return { format: "module", source: SOURCE[k], shortCircuit: true };
    }
    return next(url, ctx);
  },
});

/* ── the counted fetch: every provider request in this file passes through here ──────── */
const NET = { log: [], anthropic: 0, xai: 0 };
const json = (body, status = 200) => new Response(JSON.stringify(body),
  { status, headers: { "content-type": "application/json" } });
const sse = (frames) => new Response(
  frames.map((f) => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join(""),
  { status: 200, headers: { "content-type": "text/event-stream" } });

/* A schema-valid AnalystOut, so the REAL ask() accepts it and meters it. */
const analystAnswer = ({ kill = false, reason = "" } = {}) => JSON.stringify({
  headline: kill ? `kill: ${reason}` : "nothing disqualifying on this dimension",
  score: kill ? 4 : 61, confidence: 0.7, findings: [], risks: [], missing_data: [],
  kill, kill_reason: kill ? reason : "",
});
/* The streaming shape ask() reads. 900 in / 200 out is metered at the requested model's
   list price, which is the number printed below — Sonnet today, Haiku after the retier. */
const anthropicStream = (model, text) => sse([
  { type: "message_start", message: { id: "msg_probe", type: "message", role: "assistant",
    model, content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 900, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 200 } },
  { type: "message_stop" },
]);
const creditRefusal400 = () => json({ type: "error", error: { type: "invalid_request_error",
  message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade." } }, 400);
const notFound404 = () => json({ type: "error", error: { type: "not_found_error",
  message: "model: claude-sonnet-9 not found" } }, 404);
/* The /responses body grokXRead parses: text under output[].content[].text, and the exact
   billed amount in cost_in_usd_ticks — 1.54e9 ticks is $0.154, the live per-read figure. */
const xaiRead = () => json({ id: "resp_probe", model: "grok-4.6",
  output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({
    mentions_level: "low", verdict: "mixed", velocity: "flat", serial_rugger: false,
    paid_or_botted_signs: false, dev_handle: null, summary: "stub read" }) }] }],
  citations: [], usage: { input_tokens: 4000, output_tokens: 350, cost_in_usd_ticks: 1_540_000_000 } });

/* Which seat a request is for is read off the request itself: every seat's brief opens
   "You are the LIQUIDITY seat", and the whole serialised body is searched rather than one
   field, because WHERE llm.js places the brief (a system block, the user turn) is that
   file's business and moved once already while this test was being written. */
const seatOf = (init) => {
  const raw = typeof init?.body === "string" ? init.body : JSON.stringify(init?.body ?? {});
  let model = "?";
  try { model = JSON.parse(raw)?.model ?? "?"; } catch {}
  const m = raw.match(/You are the ([A-Z]+) seat/);
  return { seat: m ? m[1] : "?", model };
};
let SCRIPT = { anthropic: () => "ok" };     // per case: "ok" | "kill" | "credit" | "404"
globalThis.fetch = async (url, init) => {
  if (/xai/.test(String(url))) { NET.xai += 1; NET.log.push("XRead"); return xaiRead(); }
  const { seat, model } = seatOf(init);
  NET.anthropic += 1; NET.log.push(seat);
  const verdict = SCRIPT.anthropic(seat);
  if (verdict === "credit") return creditRefusal400();
  if (verdict === "404") return notFound404();
  return anthropicStream(model, analystAnswer(
    verdict === "kill" ? { kill: true, reason: `${seat.toLowerCase()} stub kill` } : {}));
};

/* ── the real modules, imported only now that the stubs are in place ─────────────────── */
const { OutOfCredit, resetCreditBreakers, noteCreditRefusal, setCreditBreakerClock,
  creditBreakerState, CREDIT_BREAKER_COOLDOWN_MS } = await import("./src/lib/llm.js");
const { xreadCacheReset } = await import("./src/lib/grok.js");
const { bus } = await import("./src/lib/bus.js");
const db = (await import("./src/lib/store.js")).default;
const { bandForMarketCap, holdWindowFor } = await import("./src/bands.js");
const { screen } = await import("./src/data/evidence.js");
const { workup, CHEAP_SEATS } = await import("./src/desk.js");
/* RE-ANCHORED 2026-09-08. These two lists were the literals ["FLOW", "LIQUIDITY",
   "TECHNICAL"] and ["FLOW", "TECHNICAL"]; Technical then retired (31 calls, $0.67 a day,
   0 kills). The PROPERTY — every seat of the cheap batch follows the read, and the
   probed seat is not bought twice — is unchanged, so the expected set is derived from
   desk.js's own CHEAP_SEATS instead of pinned here. */
const CHEAP_WIRE = [...CHEAP_SEATS].map((s) => s.toUpperCase()).sort();
const REST_WIRE = CHEAP_WIRE.filter((s) => s !== "LIQUIDITY");

/* One evidence bundle, sized to the MEDIUM band ($100k-$500k: liq 8k, vol 8k, 40 txns,
   0.5h) with every safety read present, so the REAL screen lets it through. */
const cannedEvidence = (mint, hook) => {
  const mcap = 200_000;
  return { ok: true, mint, hook, symbol: "PROBE", name: "Probe Coin",
    fetchedAt: new Date().toISOString(), band: bandForMarketCap(mcap), hold: holdWindowFor(mcap),
    promotion: null, callouts: [], deployer: { ok: false }, marketRegime: null,
    crosscheck: { verdicts: [{ check: "price", verdict: "VERIFIED", detail: "stub" }], killed: false },
    pair: { baseSymbol: "PROBE", baseName: "Probe Coin", dexId: "raydium", marketCap: mcap, fdv: mcap,
      liquidityUsd: 40_000, priceUsd: 0.0002, ageHours: 6, volume: { h24: 90_000 },
      txns: { h24: { buys: 400, sells: 300 } }, priceChange: { h1: 3, h24: 12 } },
    pairs: { count: 2, totalLiquidityUsd: 40_000, venues: ["raydium", "meteora"] },
    derived: { txns24h: 700, volToLiqRatio: 2.25, fdvToLiqRatio: 5 },
    mintAccount: { ok: true, flags: [] },
    holders: { ok: true, top1Pct: 4.2, top10Pct: 18 },
    exitProbe: { ok: true, targetSizeUsd: 75, sizeSource: "default", sizeFromBot: false, roundTripLossPct: 1.2 },
  };
};
globalThis.__PROBE = { gather: async (mint, hook) => cannedEvidence(mint, hook), reports: [] };

const EVENTS = [];
bus.on("event", (e) => EVENTS.push(e));

let clock = 1_000_000;
setCreditBreakerClock(() => clock);
const COOLDOWN = CREDIT_BREAKER_COOLDOWN_MS;

let caseNo = 0;
/** Drive the REAL workup once, from a chosen breaker state, and report what left the process. */
async function drive(label, { breaker = "closed", anthropic = () => "ok" } = {}) {
  caseNo += 1;
  resetCreditBreakers(); xreadCacheReset();
  NET.log.length = 0; NET.anthropic = 0; NET.xai = 0; EVENTS.length = 0;
  SCRIPT = { anthropic };
  if (breaker !== "closed") {
    noteCreditRefusal("anthropic", "credit balance is too low");
    clock += breaker === "cooling" ? 1_000 : COOLDOWN;   // "due": the cooldown has lapsed
  }
  const t0 = Date.now();
  const mint = `Probe${String(caseNo).padStart(2, "0")}${"1".repeat(30)}pump`;
  let rec = null, err = null;
  try { rec = await workup(`probe-${caseNo}`, mint, "probe order test"); } catch (e) { err = e; }
  const rows = db.prepare(
    "SELECT seat, COUNT(*) calls, COALESCE(SUM(usd),0) usd FROM llm_spend WHERE ts >= ? GROUP BY seat").all(t0);
  const usd = (pred) => rows.filter(pred).reduce((a, r) => a + Number(r.usd), 0);
  const metered = { xai: usd((r) => r.seat === "XRead"), anthropic: usd((r) => r.seat !== "XRead") };
  const stages = EVENTS.filter((e) => e.type === "stage").map((e) => e.stage);
  const stageDetail = (s) => EVENTS.find((e) => e.type === "stage" && e.stage === s)?.detail ?? "";
  const ends = EVENTS.filter((e) => e.type === "token:end").map((e) => e.outcome);
  const at = (pred) => EVENTS.findIndex(pred);
  console.log(`\n${label}`);
  console.log(`   order   : ${NET.log.join(" -> ") || "(nothing left the process)"}`);
  console.log(`   metered : anthropic $${metered.anthropic.toFixed(4)} (${NET.anthropic} calls) · xai $${metered.xai.toFixed(4)} (${NET.xai} reads)`);
  console.log(`   stages  : ${stages.join(", ") || "-"} · token:end ${ends.join(", ") || "-"}`);
  console.log(`   result  : ${err ? `threw ${err.constructor.name} — ${String(err.message).slice(0, 70)}` : `${rec?.outcome} by ${rec?.killedBy ?? "-"}`}`);
  return { rec, err, order: [...NET.log], net: { anthropic: NET.anthropic, xai: NET.xai },
    stages, stageDetail, ends, metered, at, breaker: creditBreakerState("anthropic") };
}

/* ══════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n0. THE FIXTURE, HELD UP TO THE REAL SCREEN FIRST");
{
  const sc = screen(cannedEvidence("fixture", "check"));
  ok("the canned evidence passes the real free screen", sc.pass === true,
    sc.pass ? "0 fails" : sc.fails.map((f) => f.code).join(", "));
}

/* ══════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n1. BREAKER CLOSED — GROK GOES SECOND AND EVERY ANALYST FOLLOWS IT (unchanged)");
{
  const a = await drive("closed; Flow kills after the read", { anthropic: (s) => s === "FLOW" ? "kill" : "ok" });
  ok("the read is the FIRST thing bought", a.order[0] === "XRead", `order ${a.order.join(" -> ")}`);
  ok("every analyst call follows it, and the read is bought once",
    a.order.indexOf("XRead") === 0 && a.order.lastIndexOf("XRead") === 0 &&
    same([...a.order.slice(1)].sort(), CHEAP_WIRE),
    `${a.net.xai} read(s), ${a.net.anthropic} analyst call(s)`);
  ok("the reputation stage precedes the first seat:thinking",
    a.at((e) => e.type === "stage" && e.stage === "reputation") < a.at((e) => e.type === "seat:thinking"),
    `reputation@${a.at((e) => e.type === "stage" && e.stage === "reputation")} thinking@${a.at((e) => e.type === "seat:thinking")}`);
  ok("no probe ran — the healthy regime never touches it", !a.stages.includes("credit_probe"), a.stages.join(", "));
  ok("the read is metered at the live figure", Math.abs(a.metered.xai - 0.154) < 1e-9, `$${a.metered.xai.toFixed(4)}`);
  ok("the analyst seats are metered too", a.metered.anthropic > 0, `$${a.metered.anthropic.toFixed(4)}`);
  ok("the kill after the read ends the workup", a.rec?.outcome === "killed" && a.rec?.killedBy === "flow",
    `${a.rec?.outcome} by ${a.rec?.killedBy}`);
  ok("...announced as deep_skipped, never as xread_skipped — the read was already paid",
    a.stages.includes("deep_skipped") && !a.stages.includes("xread_skipped"), a.stages.join(", "));
  ok("...and the detail says so", /after the reputation read/.test(a.stageDetail("deep_skipped")), a.stageDetail("deep_skipped"));
}

/* ══════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n2. BREAKER COOLING DOWN — NOTHING BOUGHT (the guard, unchanged)");
{
  const b = await drive("open; the probe is not due for another ~59s", { breaker: "cooling" });
  ok("the workup halts as OutOfCredit", b.err instanceof OutOfCredit, b.err?.message);
  ok("no request left the process", b.order.length === 0, `${b.order.length} request(s)`);
  ok("$0 metered on both providers", b.metered.anthropic === 0 && b.metered.xai === 0,
    `anthropic $${b.metered.anthropic} · xai $${b.metered.xai}`);
  ok("token:end says credit_outage", b.ends.includes("credit_outage"), b.ends.join(", "));
}

/* ══════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n3. PROBE DUE, ACCOUNT STILL DRY — ONE LIQUIDITY CALL, ZERO READS, $0 xAI");
{
  const c = await drive("open; probe due; Liquidity refused for credit", { breaker: "due", anthropic: () => "credit" });
  ok("exactly one request, and it is Liquidity", same(c.order, ["LIQUIDITY"]), `order ${c.order.join(" -> ")}`);
  ok("no read was bought and $0 xAI was metered", c.net.xai === 0 && c.metered.xai === 0,
    `${c.net.xai} read(s), $${c.metered.xai.toFixed(4)}`);
  ok("the probe's refusal halts the cycle as OutOfCredit, the way the batch would have",
    c.err instanceof OutOfCredit, c.err?.message);
  ok("the breaker is open again", c.breaker.state === "open", c.breaker.state);
  ok("the chronicle names the probe and the outage", c.stages.includes("credit_probe") && c.ends.includes("credit_outage"),
    `stages ${c.stages.join(", ")} · ends ${c.ends.join(", ")}`);
  ok("$0 Anthropic metered — a refusal has no usage", c.metered.anthropic === 0, `$${c.metered.anthropic}`);
}

/* ══════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n4. PROBE DUE, ACCOUNT TOPPED UP — LIQUIDITY, THEN THE READ, THEN THE REST");
{
  const d = await drive("open; probe due; Liquidity pays; Flow kills after the read",
    { breaker: "due", anthropic: (s) => s === "FLOW" ? "kill" : "ok" });
  ok("Liquidity is bought FIRST", d.order[0] === "LIQUIDITY", `order ${d.order.join(" -> ")}`);
  ok("the read is bought SECOND — after the probe, never before it", d.order[1] === "XRead", `order[1] = ${d.order[1]}`);
  ok(`then ${REST_WIRE.join(" and ")} — and Liquidity is not bought twice`,
    same([...d.order.slice(2)].sort(), REST_WIRE) && d.order.filter((s) => s === "LIQUIDITY").length === 1,
    `${d.order.filter((s) => s === "LIQUIDITY").length} Liquidity call(s), ${d.net.anthropic} analyst calls in all`);
  const closedAt = d.at((e) => e.type === "desk:breaker_closed");
  const readAt = d.at((e) => e.type === "stage" && e.stage === "reputation");
  ok("the breaker closed on the probe's bill BEFORE the read was bought",
    closedAt >= 0 && readAt >= 0 && closedAt < readAt, `breaker_closed@${closedAt} reputation@${readAt}`);
  ok("exactly one read, metered at the live figure", d.net.xai === 1 && Math.abs(d.metered.xai - 0.154) < 1e-9,
    `${d.net.xai} read(s), $${d.metered.xai.toFixed(4)}`);
  ok("the breaker is closed at the end", d.breaker.state === "closed", d.breaker.state);
  ok("the workup then runs exactly as in the healthy regime: Flow's kill ends it as deep_skipped",
    d.rec?.outcome === "killed" && d.rec?.killedBy === "flow" && d.stages.includes("deep_skipped"),
    `${d.rec?.outcome} by ${d.rec?.killedBy} · stages ${d.stages.join(", ")}`);
  ok("the probe's verdict is on the record, not lost", d.rec?.analysts?.liquidity?.score === 61,
    `liquidity score ${d.rec?.analysts?.liquidity?.score}`);
}

/* ══════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n5. PROBE DUE, LIQUIDITY CONDEMNS THE COIN — NO READ FOR A DEAD COIN");
{
  const e = await drive("open; probe due; Liquidity kills", { breaker: "due", anthropic: (s) => s === "LIQUIDITY" ? "kill" : "ok" });
  ok("one request, Liquidity", same(e.order, ["LIQUIDITY"]), `order ${e.order.join(" -> ")}`);
  ok("no read bought, $0 xAI", e.net.xai === 0 && e.metered.xai === 0, `${e.net.xai} read(s), $${e.metered.xai.toFixed(4)}`);
  ok("the workup ends killed by liquidity", e.rec?.outcome === "killed" && e.rec?.killedBy === "liquidity",
    `${e.rec?.outcome} by ${e.rec?.killedBy}`);
  ok("announced as xread_skipped — the one place that label is TRUE",
    e.stages.includes("xread_skipped") && /never bought/.test(e.stageDetail("xread_skipped")), e.stageDetail("xread_skipped"));
  ok("the breaker closed — the probe was billed", e.breaker.state === "closed", e.breaker.state);
}

/* ══════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n6. PROBE DUE, PROBE FAILS WITHOUT PROVING ANYTHING — STILL NO READ");
{
  const f = await drive("open; probe due; Liquidity 404s (a mis-set model, not a balance)", { breaker: "due", anthropic: () => "404" });
  ok("one request, Liquidity", same(f.order, ["LIQUIDITY"]), `order ${f.order.join(" -> ")}`);
  ok("no read bought", f.net.xai === 0 && f.metered.xai === 0, `${f.net.xai} read(s)`);
  ok("the breaker re-armed for a fresh cooldown", f.breaker.state === "open" && f.breaker.probeReadyInMs > 0,
    `${f.breaker.state}, next probe in ${f.breaker.probeReadyInMs}ms`);
  ok("so the workup ends as a credit outage rather than paying for a read no seat could follow",
    f.err instanceof OutOfCredit && f.ends.includes("credit_outage"), `${f.err?.constructor.name}: ${f.err?.message}`);
  ok("...with the real fault in the chronicle, not hidden", /without proving/.test(EVENTS.find((e) => e.type === "token:end")?.detail ?? ""),
    EVENTS.find((e) => e.type === "token:end")?.detail);
}

/* ══════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n7. THE SOURCE — THE PROBE IS GATED ON THE OUTAGE AND SITS BETWEEN THE GUARD AND THE READ");
{
  const src = fs.readFileSync(new URL("./src/desk.js", import.meta.url), "utf8");
  const guard = src.indexOf('analystCredit.state !== "closed" && analystCredit.probeReadyInMs > 0');
  const probe = src.indexOf('if (analystCredit.state !== "closed") {');
  const read = src.indexOf("await enrichWithXRead(ev, hook)");
  const cheap = src.indexOf("const cheap = await Promise.allSettled(cheapKeys.map");
  ok("guard < probe < read < analyst batch", guard > 0 && probe > guard && read > probe && cheap > read,
    `guard@${guard} probe@${probe} read@${read} batch@${cheap}`);
  ok("the probe is exactly one Liquidity seat", /Promise\.allSettled\(\[runAnalyst\("liquidity", ev\)\]\)/.test(src));
  ok("the probed seat is left out of the batch", /\.filter\(\(k\) => k !== probedSeat\)/.test(src));
  ok("the false label is gone", !src.includes("killed it before the reputation read was bought"));
  ok("the probe is announced on the chronicle", /stage: "credit_probe"/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed — during an outage the probe is a $0.03 seat, not a $0.154 read\n`);
process.exit(fail ? 1 : 0);
