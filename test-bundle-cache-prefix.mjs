/**
 * THE BUNDLE IS A CACHE HIT, OR THE DESK PAYS FOR IT EIGHT TIMES.
 *
 * Prompt caching is a byte-prefix match. Measured live over 24h before this change: the
 * PM read ~377k input tokens and had 32,039 of them served from cache (4.5%), Risk 4.4%,
 * Red Team 6.8% — and the Narrative seat, 20 calls, $3.79, $0.19 a call, ran at cached=0
 * because askWithWeb passed `system` as a plain string with no breakpoint at all. The
 * cause in ask() was PLACEMENT: the seat's brief sat in `system` between SHARED_RULES
 * and the evidence bundle, so the 8-24k-token bundle that eight seats read within
 * seconds of each other had different bytes in front of it for every seat and could
 * never be a hit for any of them.
 *
 * The fix is an ORDER, and an order is a thing a test can pin: `system` is SHARED_RULES
 * alone, the bundle is the first user block with its own breakpoint, and everything that
 * varies by seat — the brief, its standing orders, the task, the book — comes after.
 * Caches are model-scoped and an `output_config.effort` difference splits the messages
 * cache, so the ENTRY is shared per model+effort; the BYTES are asserted here to be
 * identical across every seat regardless, which is the property any entry depends on.
 *
 * Captured at the wire, not at a stubbed client: `client` is module-private in llm.js,
 * and the cache key is computed from the bytes the SDK serialises, so the request body
 * handed to fetch is the thing to look at — the same seam test-credit-breaker.mjs uses.
 * Nothing here touches the network.
 *
 *   CLAUDE_CO_DB=/tmp/x.db node test-bundle-cache-prefix.mjs
 */
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/* A direct run must not open the real database (see test-budget-reserve.mjs for the
   day that lesson cost three tables). The runner's value still wins. */
process.env.CLAUDE_CO_DB = process.env.CLAUDE_CO_DB ||
  path.join(os.tmpdir(), "cc-bundle-cache-" + process.pid + ".db");
process.env.ANTHROPIC_API_KEY = "sk-ant-not-a-real-key-for-tests";
process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9/anthropic-must-not-be-reached";
process.env.XAI_API_KEY = "xai-not-a-real-key-for-tests";
process.env.XAI_BASE_URL = "http://127.0.0.1:9/xai-must-not-be-reached";

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ok   ${label}${detail ? `  — ${detail}` : ""}`); }
  else { fail += 1; console.log(`  FAIL ${label}${detail ? `  — ${detail}` : ""}`); }
};
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);
const bytes = (s) => Buffer.byteLength(String(s), "utf8");

/* ── the wire: every provider request, as the SDK serialised it ───────────────────── */
const WIRE = [];
let nextText = () => "{}";
const say = (obj) => { nextText = () => JSON.stringify(obj); };
const json = (body, status = 200) => new Response(JSON.stringify(body),
  { status, headers: { "content-type": "application/json" } });
const sse = (frames) => new Response(
  frames.map((f) => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join(""),
  { status: 200, headers: { "content-type": "text/event-stream" } });
/* A recorded hit: 24,000 tokens read back from cache (SHARED_RULES plus a bundle),
   6,000 uncached (brief, orders, task) and 3,000 out. Carried on message_start, where
   the provider puts it, so the meter sees it through the real stream parser. */
const HIT = { input_tokens: 6_000, cache_creation_input_tokens: 0,
  cache_read_input_tokens: 24_000, output_tokens: 1 };
const streamReply = (model, text) => sse([
  { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant",
    model, content: [], stop_reason: null, stop_sequence: null, usage: HIT } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 3_000 } },
  { type: "message_stop" },
]);
const researchReply = (model) => json({
  id: "msg_r", type: "message", role: "assistant", model,
  content: [
    { type: "text", text: "Notes: the story traces to one post; two accounts repeat it in their own words." },
    { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "S4242" } },
    { type: "web_search_tool_result", tool_use_id: "srvtoolu_1",
      content: [{ type: "web_search_result", url: "https://example.org/origin", title: "The origin post" }] },
  ],
  stop_reason: "end_turn", stop_sequence: null,
  usage: { ...HIT, output_tokens: 400, server_tool_use: { web_search_requests: 1 } },
});
const grokReply = (text) => json({ id: "grok_1", model: "grok-4.6",
  choices: [{ message: { content: text } }],
  usage: { prompt_tokens: 10, completion_tokens: 4 } });

globalThis.fetch = async (url, init) => {
  const target = String(url);
  const provider = /xai/.test(target) ? "xai" : "anthropic";
  const body = JSON.parse(init?.body ?? "{}");
  WIRE.push({ provider, body });
  if (provider === "xai") return grokReply(nextText());
  return body.stream ? streamReply(body.model, nextText()) : researchReply(body.model);
};

const llm = await import("./src/lib/llm.js");
const { SHARED_RULES } = llm;
const { ANALYSTS, NARRATIVE_SYSTEM, runAnalyst, runNarrative, bundle } = await import("./src/agents/analysts.js");
const { runRedTeam, runRisk, runPM, runExecution, REDTEAM_SYSTEM, RISK_SYSTEM, PM_SYSTEM,
  EXECUTION_SYSTEM } = await import("./src/agents/decision.js");
const { cfg } = await import("./src/config.js");
const { withPolicy } = await import("./src/desk-policy.js");
const db = (await import("./src/lib/store.js")).default;

/* ── one coin, and standing orders on three seats so withPolicy has something to place ─ */
const EV = {
  symbol: "S4242", mint: "S4242Mint111111111111111111111111111111111", band: "micro",
  hold: { holdMaxMs: 3_600_000 },
  pair: { priceUsd: 0.00042, marketCap: 41_000, liquidityUsd: 12_500, ageHours: 0.4,
    socials: [{ type: "twitter", url: "https://x.com/s4242" }], websites: [],
    priceChange: { m5: 12, h1: 40, h6: 40, h24: 40 } },
  pairs: { totalLiquidityUsd: 12_500, count: 1 },
  holders: { top1Pct: 6.1, clusteredHolders: 2, bundleSuspect: false, midToHead: 0.8,
    poolsExcluded: 1, poolShareOfSupplyPct: 38, ownersResolved: true },
  exitProbe: { ok: true, roundTripLossPct: 3.2, route: "SimSwap" },
  deployer: { prior: 0, graduated: 0, dead: 0 },
  xRead: { dev_handle: "@s4242dev", dev_looks_real: true, dev_posted_ca: true,
    dev_engaging_now: true, serial_rugger: false, story_is_true: true,
    trend_stage: "emerging", early_or_late: "early" },
  promotion: { boosted: false },
  hook: "a real account with reach posted it",
};
const BUNDLE = bundle(EV);
const ORDER = "Read holders.midToHead before holders.top1Pct; the middle of the book decided the last three grades.";
db.prepare("DELETE FROM desk_policy").run();
for (const seat of ["Forensics", "Narrative", "PM"])
  db.prepare(`INSERT INTO desk_policy (seat, guidance, rationale, evidence, author, version, created_at)
              VALUES (?,?,?,?,?,?,?)`).run(seat, ORDER, "test fixture", "{}", "test", "p-test", Date.now());
db.prepare("DELETE FROM llm_spend").run();

const analystOut = (seat) => ({ headline: `${seat}: fine on my dimension`, score: 61, confidence: 0.6,
  findings: [{ claim: "liquidity is real", value: "12500", source: "pairs.totalLiquidityUsd" }],
  risks: ["thin tape"], missing_data: [], kill: false, kill_reason: "" });
const redteamOut = { headline: "the crowd is two accounts", bear_case: "attention is thin",
  attacks: [], unfalsifiable_claims: [], what_would_change_my_mind: "distinct voices",
  verdict: "wounded", confidence: 0.5 };
const riskOut = { risk_tier: "quarter", size_rationale: "wounded, not refuted", stop_price: 0.00033,
  stop_rationale: "below the launch base", liquidity_adjusted: false, portfolio_notes: "", confidence: 0.55 };
const pmOut = { decision: "WATCH", conviction: 55, thesis: "early to a true story", invalidation: "volume fades",
  time_horizon: "1h", how_red_team_was_answered: "two voices is the ordinary launch", key_disagreement: "none",
  watch_triggers: ["buys_h1 >= 40"],
  watch_rules: { price_above_usd: 0.0004, buys_h1_at_least: 40, liq_at_least_usd: null, hours: 2 } };
const ticketOut = { action: "BUY", entry_zone_low: 0.0004, entry_zone_high: 0.00045, entry_style: "scale-in",
  slices: [{ pct_of_position: 50, trigger: "now" }, { pct_of_position: 50, trigger: "holds 0.00042" }],
  max_slippage_bps: 300, suggested_route: "SimSwap", stop_price: 0.00033,
  take_profit: [{ price: 0.0009, pct_to_sell: 100, rationale: "the re-rate" }], execution_warnings: [] };

/* ── run every seat on the one coin, tagging what each one put on the wire ─────────── */
const RUNS = [];
const run = async (label, brief, fn) => {
  const start = WIRE.length;
  const out = await fn();
  const sent = WIRE.slice(start);
  RUNS.push({ label, brief, out, reqs: sent.filter((w) => w.provider === "anthropic").map((w) => w.body),
    xai: sent.filter((w) => w.provider === "xai").map((w) => w.body) });
  return out;
};
const analysts = {};
/* Derived from the table, not pinned: this read ["liquidity", "flow", "technical",
   "forensics"] until Technical retired on 2026-09-08. The property under test — one
   byte-identical prefix across every seat that reads the bundle — is about whichever
   seats the table holds. */
for (const key of Object.keys(ANALYSTS)) {
  say(analystOut(key));
  analysts[key] = await run(ANALYSTS[key].label, ANALYSTS[key].system, () => runAnalyst(key, EV));
}
say(analystOut("narrative"));
analysts.narrative = await run("Narrative", NARRATIVE_SYSTEM, () => runNarrative(EV));
say(redteamOut);
const redteam = await run("Red Team", REDTEAM_SYSTEM, () => runRedTeam(EV, analysts));
say(riskOut);
const risk = await run("Risk", RISK_SYSTEM, () => runRisk(EV, analysts, redteam));
say(pmOut);
const pm = await run("PM", PM_SYSTEM, () => runPM(EV, analysts, redteam, risk, 61.5));
say(pmOut);
const pmGrok = await run("PM(grok)", PM_SYSTEM, () => runPM(EV, analysts, redteam, risk, 61.5, { pmProvider: "grok" }));
say(ticketOut);
await run("Execution", EXECUTION_SYSTEM, () => runExecution(EV, pm, risk));

const byLabel = (l) => RUNS.find((r) => r.label === l);
const requests = RUNS.flatMap((r) => r.reqs.map((body, i) => ({
  seat: r.label + (r.reqs.length > 1 ? (i === 0 ? " (research)" : " (shape)") : ""),
  brief: r.brief, seatName: r.label, body })));
const content = (body) => body.messages[0].content;
const breakpoints = (body) => [...body.system, ...content(body)].filter((b) => b?.cache_control).length;
const escaped = (text) => JSON.stringify(text).slice(1, -1);   // the exact bytes inside the body

console.log(`\n1. THE REQUEST SHAPE — ${requests.length} Anthropic requests from ${RUNS.length} seat runs`);
{
  ok("every seat completed against the stub", RUNS.every((r) => r.out && typeof r.out === "object"),
    RUNS.map((r) => r.label).join(", "));
  for (const { seat, body } of requests) {
    const sys = body.system;
    const c = content(body);
    ok(`${seat}: system is [SHARED_RULES] with a breakpoint and nothing else`,
      Array.isArray(sys) && sys.length === 1 && sys[0].type === "text" && sys[0].text === SHARED_RULES &&
        sys[0].cache_control?.type === "ephemeral",
      `system[0] ${bytes(sys?.[0]?.text)} bytes · ${sys?.length} block(s) · cache_control=${JSON.stringify(sys?.[0]?.cache_control)}`);
    ok(`${seat}: one user turn, content as blocks, breakpoints within the API's 4`,
      body.messages.length === 1 && body.messages[0].role === "user" && Array.isArray(c) &&
        breakpoints(body) <= 4,
      `${c.length} block(s) [${c.map((b) => bytes(b.text)).join(", ")} bytes] · ${breakpoints(body)} breakpoint(s) · model ${body.model} · effort ${body.output_config?.effort ?? "-"}`);
  }
}

console.log("\n2. THE BUNDLE IS THE FIRST USER BLOCK, WITH ITS OWN BREAKPOINT, AND NOTHING SEAT-SPECIFIC PRECEDES IT");
const bundleSeats = requests.filter((r) => r.seatName !== "Execution");
{
  for (const { seat, seatName, brief, body } of bundleSeats) {
    const c = content(body);
    const orders = withPolicy(seatName, brief);
    ok(`${seat}: content[0] is the bundle, byte for byte, with cache_control`,
      c[0]?.text === BUNDLE && c[0]?.cache_control?.type === "ephemeral",
      `${bytes(c[0]?.text)} bytes · sha ${sha(c[0]?.text ?? "")} · cache_control=${JSON.stringify(c[0]?.cache_control)}`);
    ok(`${seat}: content[1] is the brief + standing orders + task, uncached, bundle not repeated`,
      c.length === 2 && c[1].cache_control == null && c[1].text.startsWith(orders) &&
        !c[1].text.includes("=== EVIDENCE BUNDLE ==="),
      `${bytes(c[1]?.text)} bytes · starts "${String(c[1]?.text).slice(0, 34)}…"`);
    const wire = JSON.stringify(body);
    const atRules = wire.indexOf(escaped(SHARED_RULES));
    const atBundle = wire.indexOf(escaped(BUNDLE));
    const atOrders = wire.indexOf(escaped(orders));
    ok(`${seat}: on the wire SHARED_RULES < bundle < withPolicy(brief)`,
      atRules >= 0 && atBundle > atRules && atOrders > atBundle && !body.system[0].text.includes(brief.slice(0, 40)),
      `offsets rules@${atRules} bundle@${atBundle} brief@${atOrders} of ${bytes(wire)}`);
  }
}

console.log("\n3. THE PREFIX IS BYTE-IDENTICAL ACROSS EVERY SEAT THAT READS THE BUNDLE");
{
  const prefixOf = (body) => JSON.stringify({ system: body.system, first: content(body)[0] });
  const prefixes = new Map(bundleSeats.map((r) => [r.seat, prefixOf(r.body)]));
  const distinct = new Set(prefixes.values());
  const one = [...distinct][0];
  ok(`${bundleSeats.length} bundle requests, one prefix (system + first user block)`,
    distinct.size === 1, `${bytes(one)} bytes · sha ${sha(one)} · seats: ${[...prefixes.keys()].join(", ")}`);
  ok("Red Team and the PM share the prefix",
    prefixes.get("Red Team") === prefixes.get("PM"), `sha ${sha(prefixes.get("Red Team"))} = ${sha(prefixes.get("PM"))}`);
  const sonnetish = bundleSeats.filter((r) => !r.body.tools && r.seatName !== "Red Team" && r.seatName !== "PM");
  ok(`the analyst, Risk and Narrative-shape seats share it too (${sonnetish.length} requests)`,
    sonnetish.every((r) => prefixes.get(r.seat) === one), sonnetish.map((r) => r.seat).join(", "));
  /* Tools render ahead of `system`, so the research call keys its own entry: same
     system, same bundle, different bytes in front. Reported, not hidden. */
  const research = requests.find((r) => r.seat === "Narrative (research)");
  const wirePrefix = (body) => JSON.stringify({ tools: body.tools ?? null, system: body.system, first: content(body)[0] });
  const wireGroups = new Map();
  for (const r of bundleSeats) wireGroups.set(wirePrefix(r.body), [...(wireGroups.get(wirePrefix(r.body)) ?? []), r.seat]);
  ok("the Narrative research call carries web_search ahead of the same prefix — its own entry",
    Array.isArray(research?.body.tools) && research.body.tools[0]?.name === "web_search" && wireGroups.size === 2,
    [...wireGroups.entries()].map(([k, seats]) => `sha ${sha(k)}: ${seats.join(", ")}`).join(" | "));
  /* The entry the provider keys is per model AND effort (an effort change invalidates
     the messages cache). This is the honest share map, derived from the requests. */
  const groups = new Map();
  for (const r of bundleSeats) {
    const k = `${r.body.model} / effort ${r.body.output_config?.effort ?? "-"}${r.body.tools ? " / +tools" : ""}`;
    groups.set(k, [...(groups.get(k) ?? []), r.seat]);
  }
  console.log("     cache entries as the provider keys them (model / effort):");
  for (const [k, seats] of groups) console.log(`       ${k}: ${seats.join(", ")}`);
  ok("Red Team and the PM key the same entry (same model and effort in config)",
    cfg.models.redteam === cfg.models.pm && cfg.effort.redteam === cfg.effort.pm,
    `${cfg.models.redteam}/${cfg.effort.redteam} vs ${cfg.models.pm}/${cfg.effort.pm}`);
  const sharedSonnet = ["forensics", "flow", "risk"].map((k) => `${cfg.models[k]}/${cfg.effort[k]}`);
  ok("Forensics, Flow and Risk key one entry between them",
    new Set(sharedSonnet).size === 1, sharedSonnet.join(" = "));
}

console.log("\n4. A SEAT WITHOUT A BUNDLE STILL GETS SHARED_RULES CACHED AND ITS BRIEF IN THE TURN");
{
  const ex = requests.find((r) => r.seatName === "Execution");
  const c = content(ex.body);
  ok("Execution: a single uncached block, brief first, then the task",
    c.length === 1 && c[0].cache_control == null && c[0].text.startsWith(withPolicy("Execution", EXECUTION_SYSTEM)) &&
      c[0].text.includes("Write the unsigned ticket for S4242") && breakpoints(ex.body) === 1,
    `${c.length} block · ${bytes(c[0].text)} bytes · ${breakpoints(ex.body)} breakpoint`);
}

console.log("\n5. STANDING ORDERS RIDE AFTER THE LAST BREAKPOINT — NEVER IN THE CACHED PREFIX");
{
  const marker = "=== STANDING ORDERS";
  for (const { seat, seatName, body } of requests.filter((r) => ["Forensics", "Narrative", "PM"].includes(r.seatName))) {
    const c = content(body);
    const tail = c[c.length - 1].text;
    const atOrders = tail.indexOf(marker);
    const task = seatName === "Forensics" ? "Analyse S4242" : seatName === "PM" ? "Decide on S4242"
      : seat.endsWith("(shape)") ? "Convert your own research notes" : "Research the narrative around S4242";
    ok(`${seat}: orders sit after the brief and before the task, in the uncached block`,
      atOrders > 0 && tail.includes(ORDER) && atOrders < tail.indexOf(task) &&
        !body.system[0].text.includes(marker) && !c[0].text.includes(marker),
      `orders@${atOrders} task@${tail.indexOf(task)} of ${bytes(tail)} bytes`);
  }
  const clean = requests.find((r) => r.seatName === "Risk");
  ok("a seat with no orders carries its bare brief",
    content(clean.body)[1].text.startsWith(RISK_SYSTEM) && !JSON.stringify(clean.body).includes(marker),
    "Risk");
}

console.log("\n6. askWithWeb — the research call and the shaping call carry the same block");
{
  const research = requests.find((r) => r.seat === "Narrative (research)").body;
  const shape = requests.find((r) => r.seat === "Narrative (shape)").body;
  ok("research: stream off, web_search on, output_config effort as configured",
    research.stream !== true && research.tools?.[0]?.max_uses === 2 && research.output_config?.effort === cfg.effort.narrative,
    `effort ${research.output_config?.effort}`);
  const tail = content(shape)[1].text;
  ok("shape: notes, the sources actually read, then the ORIGINAL brief — without the bundle",
    tail.includes("=== YOUR RESEARCH NOTES ===\nNotes: the story traces") &&
      tail.includes("=== SOURCES YOU ACTUALLY READ ===\nThe origin post — https://example.org/origin") &&
      tail.includes("=== ORIGINAL BRIEF ===\nResearch the narrative around S4242") &&
      !tail.includes("=== EVIDENCE BUNDLE ==="),
    `${bytes(tail)} bytes · effort ${shape.output_config?.effort}`);
  ok("shape: content[0] is the identical bundle block", content(shape)[0].text === BUNDLE &&
    content(shape)[0].cache_control?.type === "ephemeral", `sha ${sha(content(shape)[0].text)}`);
}

console.log("\n7. THE GROK PM KEEPS THE BUNDLE INLINE — IT HAS NO PREFIX CACHE TO PLACE IT IN");
{
  const g = byLabel("PM(grok)");
  const xai = g.xai[0];
  const user = xai?.messages?.[1]?.content ?? "";
  ok("the Grok request went out and was answered on Grok", g.xai.length === 1 && g.out?._provider === "grok",
    `_provider=${g.out?._provider}`);
  ok("its system prompt is SHARED_RULES + PM_SYSTEM, its user prompt carries the bundle before the book",
    String(xai?.messages?.[0]?.content ?? "").startsWith(SHARED_RULES + "\n\n" + PM_SYSTEM) &&
      user.includes(BUNDLE) && user.indexOf(BUNDLE) < user.indexOf("=== ANALYST BOOK ===") &&
      user.startsWith("Decide on S4242"),
    `bundle@${user.indexOf(BUNDLE)} book@${user.indexOf("=== ANALYST BOOK ===")} of ${bytes(user)} bytes`);
  const claude = byLabel("PM").reqs[0];
  ok("...while the Claude PM's tail holds book, red team, risk and composite with no second bundle",
    ["=== ANALYST BOOK ===", "=== RED TEAM ===", "=== RISK ===", "=== WEIGHTED ANALYST COMPOSITE ==="]
      .every((m) => content(claude)[1].text.includes(m)) && !content(claude)[1].text.includes("=== EVIDENCE BUNDLE ==="),
    `${bytes(content(claude)[1].text)} bytes`);
}

console.log("\n8. THE COVERAGE GATE STILL RESOLVES EVERY system: SITE BY NAME");
{
  const root = path.dirname(fileURLToPath(import.meta.url));
  const gate = spawnSync(process.execPath, ["test-desk-says-what-and-when.mjs"], {
    cwd: root, encoding: "utf8", timeout: 90_000,
    env: { ...process.env, NODE_ENV: "test", ANTHROPIC_API_KEY: "", XAI_API_KEY: "",
      CLAUDE_CO_DB: path.join(os.tmpdir(), "cc-bundle-cache-gate-" + process.pid + ".db") },
  });
  const line = (gate.stdout || "").split("\n").find((l) => /every system: site in src\/ names a swept brief/.test(l));
  ok("test-desk-says-what-and-when.mjs passes, its system: gate green",
    gate.status === 0 && /^\s*ok\s/.test(line || ""), (line || gate.stderr || "no gate line").trim());
  const summary = (gate.stdout || "").split("\n").find((l) => /\d+ passed, \d+ failed/.test(l));
  ok("...and it reports zero failures", /^\d+ passed, 0 failed$/.test((summary || "").trim()), summary?.trim());
}

console.log("\n9. WHAT A HIT COSTS, THROUGH THE METER — a recorded PM-shaped usage replayed");
{
  const usage = (u) => ({ model: "claude-opus-5", usage: u });
  const hit = usage({ input_tokens: 6_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 24_000, output_tokens: 3_000 });
  const cold = usage({ input_tokens: 6_000, cache_creation_input_tokens: 24_000, cache_read_input_tokens: 0, output_tokens: 3_000 });
  const none = usage({ input_tokens: 30_000, output_tokens: 3_000 });
  const charged = llm.meterAnthropicUsage("claude-opus-5", hit, "PM", "high");
  const row = db.prepare("SELECT id, seat, model, in_tok, cached_tok, usd FROM llm_spend ORDER BY id DESC LIMIT 1").get();
  const coldUsd = llm.anthropicUsageCost("claude-opus-5", cold).usd;
  const noneUsd = llm.anthropicUsageCost("claude-opus-5", none).usd;
  console.log(`     hit  (24k read @0.1x + 6k in + 3k out): $${charged.usd.toFixed(4)}`);
  console.log(`     cold (24k write @ the meter's 2x)      : $${coldUsd.toFixed(4)}  (documented 5-min write is 1.25x → $${(coldUsd - 24_000 / 1e6 * 5 * 0.75).toFixed(4)})`);
  console.log(`     none (30k uncached)                    : $${noneUsd.toFixed(4)}`);
  ok("the hit is charged $0.1170 — cache reads at 0.1x", Math.abs(charged.usd - 0.117) < 1e-9, `$${charged.usd.toFixed(4)}`);
  ok("a hit is cheaper than the uncached call by the read discount",
    Math.abs((noneUsd - charged.usd) - 0.108) < 1e-9, `saves $${(noneUsd - charged.usd).toFixed(4)} on this shape`);
  ok("the ledger row keeps total input and the cached share",
    row.seat === "PM" && row.in_tok === 30_000 && row.cached_tok === 24_000 && Math.abs(row.usd - 0.117) < 1e-9,
    JSON.stringify({ seat: row.seat, model: row.model, in_tok: row.in_tok, cached_tok: row.cached_tok, usd: row.usd }));
  /* And the seats above were metered from the real stream parser, cache fields intact:
     every Anthropic row before the replay is one of the requests captured on the wire. */
  const anthRows = db.prepare(`SELECT seat, model, in_tok, cached_tok, ROUND(usd,4) usd FROM llm_spend
                               WHERE id != ? AND model LIKE 'claude%' ORDER BY id`).all(row.id);
  ok(`every streamed seat's ledger row carries the provider's cache_read (${anthRows.length} rows)`,
    anthRows.length === requests.length && anthRows.every((r) => r.cached_tok === 24_000 && r.in_tok === 30_000),
    anthRows.map((r) => `${r.seat}:${r.cached_tok}/${r.in_tok} $${r.usd}`).join(" · "));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
