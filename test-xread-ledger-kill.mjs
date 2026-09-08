/**
 * THE SECOND COIN FROM A KNOWN RUGGER IS CAUGHT FOR FREE.
 *
 * devrep.js remembers a creator by the one identity they cannot rotate — the X account —
 * and states its purpose plainly: "the second coin from a known rugger is caught for
 * free". It was not. The ledger was consulted only inside enrichWithXRead, AFTER the
 * ~$0.15 read had been paid for, and workup() killed only on the FRESH read's
 * serial_rugger. Live ledger when this was written: 21 serial ruggers against 288
 * suspects; the X read runs 110 times a day ($14.69) against 31 Liquidity calls.
 *
 * desk.js now asks the ledger BEFORE buying the read, through the same creatorHandle()
 * resolution the read itself starts from. A SOURCED serial_rugger ends the workup at $0
 * as the existing SAFETY kill (deployer_has_rugged, calls.js GATE_CLASS); suspect, clean
 * and unknown change nothing and buy the read exactly once, as before. Tightening only.
 *
 * WHAT IS REAL: workup(), the free screen, creatorHandle(), enrichWithXRead(),
 * grokXRead() with its meter and the llm_spend ledger, the devrep ledger, the verdicts
 * table, gateFailures(). WHAT IS STUBBED: the network (a counted fetch answering as each
 * provider would — what left the process IS the evidence), gather() (one canned bundle
 * the REAL screen is shown to pass) and writeReport (kept out of the repo). The same
 * harness as test-xread-probe-order.mjs.
 */
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const REPO = path.dirname(new URL(import.meta.url).pathname);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "xread-ledger-"));
process.env.CLAUDE_CO_DB = process.env.CLAUDE_CO_DB || path.join(TMP, "ledger.db");
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

/* ── the stub layer: gather() and the scribe, the way test-xread-probe-order.mjs does it ── */
const F = (rel) => pathToFileURL(path.join(REPO, rel)).href;
const STUBBED = new Map([
  [F("src/data/evidence.js"), "evidence"],
  [F("src/report.js"), "report"],
]);
const SOURCE = {
  /* screen(), creatorHandle() and enrichWithXRead() stay REAL — only the network-bound
     gather() is canned. */
  evidence: `
    export * from "${F("src/data/evidence.js")}?ledger=real";
    export async function gather(mint, hook) { return globalThis.__LEDGER.gather(mint, hook); }
  `,
  report: `
    export * from "${F("src/report.js")}?ledger=real";
    export function writeReport(cycle, r) {
      globalThis.__LEDGER.reports.push({ cycle, symbol: r?.symbol, outcome: r?.outcome });
      return "reports/ledger-test/" + String(cycle) + "__" + (r?.symbol || "x") + ".md";
    }
  `,
};
registerHooks({
  resolve(spec, ctx, next) {
    const r = next(spec, ctx);
    if (String(r.url).includes("ledger=real")) return r;
    const key = STUBBED.get(String(r.url));
    if (!key) return r;
    return { ...r, url: `${r.url}?ledger=stub&k=${key}`, format: "module", shortCircuit: true };
  },
  load(url, ctx, next) {
    const u = String(url);
    if (u.includes("ledger=stub")) {
      const k = new URL(u).searchParams.get("k");
      return { format: "module", source: SOURCE[k], shortCircuit: true };
    }
    return next(url, ctx);
  },
});

/* ── the counted fetch: every provider request in this file passes through here ──────── */
const NET = { log: [], anthropic: 0, xai: 0, told: null };
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
const anthropicStream = (model, text) => sse([
  { type: "message_start", message: { id: "msg_ledger", type: "message", role: "assistant",
    model, content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 900, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 200 } },
  { type: "message_stop" },
]);
/* The /responses body grokXRead parses; 1.54e9 ticks is $0.154, the live per-read figure.
   dev_handle is null on purpose: the paid read must not touch the ledger this test seeds,
   so the verdicts under test are exactly the ones written below. */
const xaiRead = () => json({ id: "resp_ledger", model: "grok-4.6",
  output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({
    mentions_level: "low", verdict: "mixed", velocity: "flat", serial_rugger: false,
    paid_or_botted_signs: false, dev_handle: null, summary: "stub read" }) }] }],
  citations: [], usage: { input_tokens: 4000, output_tokens: 350, cost_in_usd_ticks: 1_540_000_000 } });

const seatOf = (init) => {
  const raw = typeof init?.body === "string" ? init.body : JSON.stringify(init?.body ?? {});
  let model = "?";
  try { model = JSON.parse(raw)?.model ?? "?"; } catch {}
  const m = raw.match(/You are the ([A-Z]+) seat/);
  return { seat: m ? m[1] : "?", model };
};
globalThis.fetch = async (url, init) => {
  if (/xai/.test(String(url))) {
    NET.xai += 1; NET.log.push("XRead");
    /* The handle Grok was told to start from — read off the request itself, so the test
       can show the ledger and the read were asked about the SAME account. */
    const raw = typeof init?.body === "string" ? init.body : "";
    const m = raw.match(/The launchpad lists (\S+) as the coin's own account/);
    NET.told = m ? m[1] : null;
    return xaiRead();
  }
  const { seat, model } = seatOf(init);
  NET.anthropic += 1; NET.log.push(seat);
  /* Flow condemns every coin that gets this far, so a workup that buys the read ends
     right after the cheap batch (deep_skipped) — three seats, then done. */
  return anthropicStream(model, analystAnswer(
    seat === "FLOW" ? { kill: true, reason: "flow stub kill" } : {}));
};

/* ── the real modules, imported only now that the stubs are in place ─────────────────── */
const { spend, resetCreditBreakers, noteCreditRefusal, setCreditBreakerClock,
  creditBreakerState, CREDIT_BREAKER_COOLDOWN_MS } = await import("./src/lib/llm.js");
const { xreadCacheReset } = await import("./src/lib/grok.js");
const { bus } = await import("./src/lib/bus.js");
const db = (await import("./src/lib/store.js")).default;
const store = await import("./src/lib/store.js");
const { bandForMarketCap, holdWindowFor } = await import("./src/bands.js");
const { screen, creatorHandle } = await import("./src/data/evidence.js");
const { recordDev, reputationFor } = await import("./src/devrep.js");
const { GATE_CLASS, gateFailures, isSafetyGate } = await import("./src/calls.js");
const { workup, ruggerOnLedger } = await import("./src/desk.js");

/* One evidence bundle, sized to the MEDIUM band with every safety read present, so the
   REAL screen lets it through; the deployer block is the only thing that varies. A
   deployer with 1 prior launch is far under the launch-farm bar (8+, none graduated). */
const cannedEvidence = (mint, hook, deployer) => {
  const mcap = 200_000;
  return { ok: true, mint, hook, symbol: "LEDG", name: "Ledger Coin",
    fetchedAt: new Date().toISOString(), band: bandForMarketCap(mcap), hold: holdWindowFor(mcap),
    promotion: null, callouts: [], deployer, marketRegime: null,
    crosscheck: { verdicts: [{ check: "price", verdict: "VERIFIED", detail: "stub" }], killed: false },
    pair: { baseSymbol: "LEDG", baseName: "Ledger Coin", dexId: "raydium", marketCap: mcap, fdv: mcap,
      liquidityUsd: 40_000, priceUsd: 0.0002, ageHours: 6, volume: { h24: 90_000 },
      txns: { h24: { buys: 400, sells: 300 } }, priceChange: { h1: 3, h24: 12 } },
    pairs: { count: 2, totalLiquidityUsd: 40_000, venues: ["raydium", "meteora"] },
    derived: { txns24h: 700, volToLiqRatio: 2.25, fdvToLiqRatio: 5 },
    mintAccount: { ok: true, flags: [] },
    holders: { ok: true, top1Pct: 4.2, top10Pct: 18 },
    exitProbe: { ok: true, targetSizeUsd: 75, sizeSource: "default", sizeFromBot: false, roundTripLossPct: 1.2 },
  };
};
/** The pump.fun deployer read as gather() shapes it, with the coin's socials. */
const pfDeployer = ({ twitter = null, creatorUsername = null } = {}) => ({
  ok: true, creator: "CreatorWallet1111111111111111111111111111111", priorLaunches: 1, graduated: 0,
  coin: { twitter, creatorUsername, description: "a coin about a ledger" },
});
let DEPLOYER = { ok: false };
globalThis.__LEDGER = { gather: async (mint, hook) => cannedEvidence(mint, hook, DEPLOYER), reports: [] };

const EVENTS = [];
bus.on("event", (e) => EVENTS.push(e));

let clock = 1_000_000;
setCreditBreakerClock(() => clock);

/* ── the ledger, seeded exactly as recordDev files a read's findings ─────────────────── */
console.log("\n0. THE LEDGER, SEEDED THE WAY THE PAID READ WRITES IT");
recordDev({ handle: "@RugLord", serialRugger: true,
  rugEvidence: "launched $FOO 2026-06-03 and $BAR 2026-07-11, both -99% inside a day; replies full of 'dev sold'",
  symbol: "BAZ", mint: "seed-mint-1" });
recordDev({ handle: "@ShadyDev", serialRugger: true, rugEvidence: "idk", symbol: "SHD", mint: "seed-mint-2" });
recordDev({ handle: "@NicePerson", serialRugger: false, rugEvidence: null, symbol: "NIC", mint: "seed-mint-3" });
recordDev({ handle: "@Ghosted", serialRugger: null, rugEvidence: null, symbol: "GH", mint: "seed-mint-4" });
const verdictOf = (h) => reputationFor(h)?.verdict ?? "(no row)";
for (const h of ["@RugLord", "@ShadyDev", "@NicePerson", "@Ghosted", "@NeverSeen"])
  console.log(`   ${h.padEnd(12)} -> ledger verdict: ${verdictOf(h)}`);
ok("a SOURCED rugging is on the ledger as serial_rugger", verdictOf("@RugLord") === "serial_rugger", verdictOf("@RugLord"));
ok("an unsourced accusation is filed as suspect, never as a rugger", verdictOf("@ShadyDev") === "suspect", verdictOf("@ShadyDev"));
ok("a clean read is clean; a null read is unknown; an unseen handle has no row",
  verdictOf("@NicePerson") === "clean" && verdictOf("@Ghosted") === "unknown" && verdictOf("@NeverSeen") === "(no row)",
  `${verdictOf("@NicePerson")} / ${verdictOf("@Ghosted")} / ${verdictOf("@NeverSeen")}`);
{
  const sc = screen(cannedEvidence("fixture", "check", pfDeployer({ twitter: "https://x.com/RugLord" })));
  ok("the canned evidence passes the real free screen — a known rugger is NOT a screen fact",
    sc.pass === true, sc.pass ? "0 fails" : sc.fails.map((f) => f.code).join(", "));
}

/* ── drive the REAL workup once and report what left the process ────────────────────── */
const xreadRows = () => db.prepare("SELECT COUNT(*) n FROM llm_spend WHERE seat='XRead'").get().n;
let caseNo = 0;
async function drive(label, deployer, { breaker = "closed" } = {}) {
  caseNo += 1;
  resetCreditBreakers(); xreadCacheReset();
  NET.log.length = 0; NET.anthropic = 0; NET.xai = 0; NET.told = null; EVENTS.length = 0;
  DEPLOYER = deployer;
  if (breaker !== "closed") {
    noteCreditRefusal("anthropic", "credit balance is too low");
    clock += breaker === "cooling" ? 1_000 : CREDIT_BREAKER_COOLDOWN_MS;   // "due": the cooldown lapsed
  }
  const t0 = Date.now();
  const before = { rows: xreadRows(), usd: spend.usd, calls: spend.calls };
  const mint = `Ledger${String(caseNo).padStart(2, "0")}${"1".repeat(30)}pump`;
  const ev = cannedEvidence(mint, "ledger test", deployer);
  const handle = creatorHandle(ev);
  let rec = null, err = null;
  try { rec = await workup(`ledger-${caseNo}`, mint, "ledger test"); } catch (e) { err = e; }
  const rows = db.prepare(
    "SELECT seat, COUNT(*) calls, COALESCE(SUM(usd),0) usd FROM llm_spend WHERE ts >= ? GROUP BY seat").all(t0);
  const usd = (pred) => rows.filter(pred).reduce((a, r) => a + Number(r.usd), 0);
  const metered = { xai: usd((r) => r.seat === "XRead"), anthropic: usd((r) => r.seat !== "XRead") };
  const delta = { rows: xreadRows() - before.rows, usd: spend.usd - before.usd, calls: spend.calls - before.calls };
  const stages = EVENTS.filter((e) => e.type === "stage").map((e) => e.stage);
  const ends = EVENTS.filter((e) => e.type === "token:end").map((e) => e.outcome);
  const verdicts = db.prepare("SELECT seat, killed, reason, json FROM verdicts WHERE mint=? ORDER BY id").all(mint)
    .map((v) => ({ ...v, json: JSON.parse(v.json) }));
  const ledger = handle ? verdictOf(handle) : "(no handle)";
  console.log(`\n${label}`);
  console.log(`   handle  : ${handle ?? "(none)"} · ledger verdict: ${ledger} · Grok was told: ${NET.told ?? "(nothing — no read)"}`);
  console.log(`   order   : ${NET.log.join(" -> ") || "(nothing left the process)"}`);
  console.log(`   reads   : ${NET.xai} bought · xai metered $${metered.xai.toFixed(4)} · llm_spend XRead rows +${delta.rows} · spend.usd +$${delta.usd.toFixed(4)} (+${delta.calls} calls)`);
  console.log(`   stages  : ${stages.join(", ") || "-"} · token:end ${ends.join(", ") || "-"}`);
  console.log(`   result  : ${err ? `threw ${err.constructor.name} — ${String(err.message).slice(0, 70)}` : `${rec?.outcome} by ${rec?.killedBy ?? "-"}${rec?.killArm ? ` (${rec.killArm})` : ""}`}`);
  return { rec, err, mint, handle, ledger, told: NET.told, order: [...NET.log],
    net: { anthropic: NET.anthropic, xai: NET.xai }, metered, delta, stages, ends, verdicts,
    breaker: creditBreakerState("anthropic") };
}

/* ══════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n1. A KNOWN RUGGER'S NEXT COIN — KILLED FOR $0, THE READ NEVER BOUGHT");
{
  const a = await drive("RugLord relaunches; the launchpad links x.com/RugLord",
    pfDeployer({ twitter: "https://x.com/RugLord?s=21", creatorUsername: "somebody_else" }));
  ok("the workup ends killed, by the XRead seat, on the serial_rugger arm",
    a.rec?.outcome === "killed" && a.rec?.killedBy === "xread" && a.rec?.killArm === "serial_rugger",
    `${a.rec?.outcome} by ${a.rec?.killedBy} (${a.rec?.killArm})`);
  ok("grokXRead was never invoked — zero reads left the process", a.net.xai === 0, `${a.net.xai} read(s)`);
  ok("nothing at all was bought — no analyst seat either", a.order.length === 0 && Object.keys(a.rec?.analysts ?? {}).length === 0,
    `${a.order.length} request(s), ${Object.keys(a.rec?.analysts ?? {}).length} seat(s) on the record`);
  ok("xAI spend is unchanged: $0 metered, no llm_spend XRead row, the in-memory meter untouched",
    a.metered.xai === 0 && a.delta.rows === 0 && a.delta.usd === 0 && a.delta.calls === 0,
    `metered $${a.metered.xai} · rows +${a.delta.rows} · spend +$${a.delta.usd} / +${a.delta.calls} calls`);
  const xv = a.verdicts.find((v) => v.seat === "XRead");
  ok("an XRead FAIL verdict is on the record, marked as the ledger's and naming the handle",
    !!xv && xv.killed === 1 && xv.json.verdict === "FAIL" && xv.json.from_ledger === true && xv.json.handle === "ruglord",
    xv ? `killed=${xv.killed} verdict=${xv.json.verdict} from_ledger=${xv.json.from_ledger} handle=${xv.json.handle}` : "no XRead verdict row");
  ok("the reason carries the ledger's own evidence, not a bare verdict",
    /@ruglord/.test(a.rec?.reason ?? "") && /\$FOO/.test(a.rec?.reason ?? "") && /on the desk's ledger/.test(a.rec?.reason ?? ""),
    String(a.rec?.reason).slice(0, 120));
  const gates = gateFailures(a.rec);
  ok("it classifies as the existing SAFETY gate deployer_has_rugged — no new code, nothing left to default-deny",
    gates.length === 1 && gates[0].code === "deployer_has_rugged" && gates[0].cls === "SAFETY" &&
    Object.hasOwn(GATE_CLASS, "deployer_has_rugged") && isSafetyGate("deployer_has_rugged"),
    gates.map((g) => `${g.code}:${g.cls}`).join(", "));
  ok("nothing was waived to get there", Array.isArray(a.rec?.relaxations) && a.rec.relaxations.length === 0,
    `${a.rec?.relaxations?.length ?? "?"} relaxation(s)`);
  ok("the chronicle names the ledger and never announces a reputation stage",
    a.stages.includes("ledger") && !a.stages.includes("reputation") && a.ends.includes("killed"),
    `stages ${a.stages.join(", ")} · ends ${a.ends.join(", ")}`);
  const rk = store.recentKill(a.mint);
  ok("the free kill keeps the coin out of the universe like any other — recentKill sees it",
    !!rk && rk.seat === "XRead", rk ? `${rk.seat}: ${String(rk.reason).slice(0, 60)}` : "no recent kill");
}

/* ══════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n2. THE SAME IDENTITY, HOWEVER THE LAUNCHPAD WROTE IT");
{
  const b = await drive("no profile link; pump.fun's creatorUsername is RugLord",
    pfDeployer({ twitter: null, creatorUsername: "RugLord" }));
  ok("the username fallback reaches the same ledger row — killed, zero reads",
    b.rec?.killArm === "serial_rugger" && b.net.xai === 0, `${b.rec?.outcome} (${b.rec?.killArm}) · ${b.net.xai} read(s)`);
  const c = await drive("a lowercase twitter.com link to a POST by ruglord",
    pfDeployer({ twitter: "https://twitter.com/ruglord/status/1234567890" }));
  ok("case and domain do not matter, and a post link still names its author — killed, zero reads",
    c.rec?.killArm === "serial_rugger" && c.net.xai === 0, `${c.rec?.outcome} (${c.rec?.killArm}) · ${c.net.xai} read(s)`);
}

/* ══════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n3. THE LEDGER AND THE READ ARE ASKED ABOUT ONE ACCOUNT — creatorHandle() DECIDES FOR BOTH");
{
  const d = await drive("the profile link says NicePerson; creatorUsername says RugLord",
    pfDeployer({ twitter: "https://x.com/NicePerson", creatorUsername: "RugLord" }));
  ok("the link wins, exactly as enrichWithXRead resolves it — so the ledger is asked about @NicePerson",
    d.handle === "@NicePerson" && d.ledger === "clean", `handle ${d.handle} · ledger ${d.ledger}`);
  ok("...and Grok is told the SAME handle the ledger was asked about", d.told === "@NicePerson", `told ${d.told}`);
  ok("no ledger kill — the read is bought exactly once and the workup goes on",
    d.net.xai === 1 && d.stages.includes("reputation") && d.rec?.killedBy === "flow",
    `${d.net.xai} read(s) · ${d.rec?.outcome} by ${d.rec?.killedBy}`);
}

/* ══════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n4. SUSPECT, CLEAN, UNKNOWN, UNSEEN, NO HANDLE — EACH BUYS THE READ EXACTLY ONCE");
{
  const cases = [
    ["suspect (an unsourced accusation)", pfDeployer({ twitter: "https://x.com/ShadyDev" }), "@ShadyDev"],
    ["clean", pfDeployer({ twitter: "https://x.com/NicePerson" }), "@NicePerson"],
    ["unknown (a row the read could not judge)", pfDeployer({ twitter: "https://x.com/Ghosted" }), "@Ghosted"],
    ["unseen (no row at all)", pfDeployer({ twitter: "https://x.com/NeverSeen" }), "@NeverSeen"],
    ["no handle (deployer unknown)", { ok: false }, null],
  ];
  for (const [what, deployer, expectHandle] of cases) {
    const r = await drive(`creator is ${what}`, deployer);
    ok(`${what}: resolves to ${expectHandle ?? "no handle"} and the ledger does not condemn`,
      r.handle === expectHandle && r.ledger !== "serial_rugger", `handle ${r.handle} · ledger ${r.ledger}`);
    ok(`${what}: the read is bought exactly once, metered at the live figure, and the workup continues`,
      r.net.xai === 1 && Math.abs(r.metered.xai - 0.154) < 1e-9 && r.delta.rows === 1 &&
      r.stages.includes("reputation") && !r.stages.includes("ledger") && r.rec?.killedBy === "flow",
      `${r.net.xai} read(s) · $${r.metered.xai.toFixed(4)} · +${r.delta.rows} row · ${r.rec?.outcome} by ${r.rec?.killedBy}`);
    ok(`${what}: Grok was told ${expectHandle ?? "no handle"}`, r.told === expectHandle, `told ${r.told}`);
  }
}

/* ══════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n5. DURING AN OUTAGE THE PROBE STILL RUNS, AND THE LEDGER STILL BEATS THE READ");
{
  const e = await drive("breaker open, probe due; RugLord relaunches",
    pfDeployer({ twitter: "https://x.com/RugLord" }), { breaker: "due" });
  ok("Liquidity is bought as the probe — the breaker needs a bill and that is its job",
    same(e.order, ["LIQUIDITY"]) && e.breaker.state === "closed", `order ${e.order.join(" -> ")} · breaker ${e.breaker.state}`);
  ok("then the ledger kills before the read: zero reads, killed on serial_rugger",
    e.net.xai === 0 && e.metered.xai === 0 && e.rec?.killArm === "serial_rugger",
    `${e.net.xai} read(s), $${e.metered.xai.toFixed(4)} · ${e.rec?.outcome} (${e.rec?.killArm})`);
  ok("the probe's verdict stays on the record", e.rec?.analysts?.liquidity?.score === 61,
    `liquidity score ${e.rec?.analysts?.liquidity?.score}`);
}

/* ══════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n6. THE RULE ITSELF — ONLY A SOURCED serial_rugger CONDEMNS");
{
  const evFor = (twitter) => cannedEvidence("rule", "rule", pfDeployer({ twitter }));
  const hit = ruggerOnLedger(evFor("https://x.com/RugLord"));
  ok("serial_rugger -> the ledger row, with the handle it was matched on",
    hit?.verdict === "serial_rugger" && hit?.handle === "ruglord" && hit.tokens.length >= 1,
    hit ? `${hit.handle}: ${hit.verdict}, ${hit.tokens.length} launch(es) seen` : "null");
  for (const [h, v] of [["ShadyDev", "suspect"], ["NicePerson", "clean"], ["Ghosted", "unknown"], ["NeverSeen", "(no row)"]]) {
    const r = ruggerOnLedger(evFor(`https://x.com/${h}`));
    ok(`${v} -> null (changes nothing)`, r === null && verdictOf(h) === v, `${h}: ${verdictOf(h)} -> ${r}`);
  }
  ok("no handle -> null, never a throw", ruggerOnLedger(cannedEvidence("x", "x", { ok: false })) === null &&
    ruggerOnLedger({}) === null && ruggerOnLedger(null) === null);
}

/* ══════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n7. THE SOURCE — THE LEDGER SITS AFTER THE PROBE AND BEFORE THE READ, ON THE SHARED RESOLUTION");
{
  const desk = fs.readFileSync(new URL("./src/desk.js", import.meta.url), "utf8");
  const probe = desk.indexOf('if (analystCredit.state !== "closed") {');
  const ledger = desk.indexOf("const rugger = ruggerOnLedger(ev);");
  const stage = desk.indexOf('emit("stage", { stage: "reputation"');
  const read = desk.indexOf("await enrichWithXRead(ev, hook)");
  ok("probe < ledger < reputation stage < read", probe > 0 && ledger > probe && stage > ledger && read > stage,
    `probe@${probe} ledger@${ledger} stage@${stage} read@${read}`);
  ok("desk.js reads the ledger through devrep.js and resolves the handle through evidence.js",
    /import \{ reputationFor \} from "\.\/devrep\.js"/.test(desk) && /creatorHandle \} from "\.\/data\/evidence\.js"/.test(desk));
  ok("the kill is the existing xread serial_rugger arm — killedBy xread, killArm serial_rugger, recorded, ended",
    /killedBy: "xread", killArm: "serial_rugger"/.test(desk) && /from_ledger: true/.test(desk));
  const evidence = fs.readFileSync(new URL("./src/data/evidence.js", import.meta.url), "utf8");
  const enrich = evidence.slice(evidence.indexOf("export async function enrichWithXRead"));
  ok("enrichWithXRead starts from creatorHandle(ev) and no longer resolves the handle by hand",
    /const handle = creatorHandle\(ev\);/.test(enrich) && !/handleFromUrl\(pfCoin\?\.twitter\)/.test(enrich));
  ok("the resolution exists exactly once, inside creatorHandle",
    (evidence.split("handleFromUrl(pfCoin?.twitter) ?? pfCoin?.creatorUsername").length - 1) === 1);
}

console.log(`\n${pass} passed, ${fail} failed — a rugger the desk already knows is caught for $0, before the read\n`);
process.exit(fail ? 1 : 0);
