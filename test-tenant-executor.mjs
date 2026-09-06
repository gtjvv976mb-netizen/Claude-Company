/**
 * A TENANT FLOOR TRADES THE SAME ROAD THE HOUSE DOES.
 *
 * test-hq-executor.mjs proved the house's own floor receives its calls. Shipping the
 * bot to every floor means a LEASED floor with untouched defaults must receive a
 * published call as an executable offer, see it on its own secret-gated executor
 * feed with size, rules and verdicts, and never see key material. Every route is
 * parameterised by floor number; this pins that no house-only assumption crept in.
 */
process.env.CLAUDE_CO_DB = process.env.CLAUDE_CO_DB || "/tmp/tenant-executor-test.db";
import fs from "node:fs";
try { fs.rmSync(process.env.CLAUDE_CO_DB); } catch {}

const db = (await import("./src/lib/store.js")).default;
const { openCall, closeCall, liveCalls } = await import("./src/calls.js");
const alerts = await import("./src/alerts.js");
const { broadcast, decide, settingsFor, saveSettings } = await import("./src/copy.js");
const { executorFeedPayload } = await import("./src/office.js");
const { listFloors } = await import("./src/tower.js");

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

console.log("\nA LEASED FLOOR WITH DEFAULT SETTINGS");
const FLOOR = 7;
const WALLET = "TenantWa11et111111111111111111111111111111111";
db.prepare("UPDATE floors SET state='owned', owner=?, name=?, claimed_at=? WHERE n=?")
  .run(WALLET, "Seventh Floor Capital", Date.now(), FLOOR);
ok("floor 7 is leased", listFloors().find((f) => f.n === FLOOR)?.state === "owned");
const s = settingsFor(FLOOR);
ok("a fresh floor is seeded with the appetite this desk actually publishes for",
  s.appetite === "aggressive" && Number(s.bankroll_sol) === 5, `appetite=${s.appetite} bankroll=${s.bankroll_sol}`);
ok("...and its own feed secret, with no webhook", !!s.executor_secret && !s.executor_url,
  `${s.executor_secret.length} chars`);

console.log("\nA PUBLISHED CALL REACHES THE TENANT AS AN EXECUTABLE OFFER");
for (const c of liveCalls()) closeCall(c.id, "test_reset", 1);
const call = openCall({
  mint: "TenantCa11111111111111111111111111111111111", symbol: "TNT",
  category: "memecoin", launchpad: "pump.fun", conviction: 62,
  entryRef: 0.0010, stop: 0.00075, target: 0.0021,
  thesis: "a tenant-grade call", invalidation: "volume dies",
  liqUsd: 120_000, rtLossPct: 1.2, policyVersion: "test-policy-v42",
  deskSizeUsd: 3.4, deskEquityUsd: 10_000,   // the house's tiny proportional allocation
});
const d = decide(FLOOR, call);
ok("the default tenant is OFFERED the call", d.verdict === "offered", `${d.verdict} — ${(d.reason || "").slice(0, 90)}`);
/* THE SIZE ASSERTION INVERTED ON 2026-09-07. It read `Number(d.sizeSol) >= 0.02` —
   the desk offering a tenant a number that clears Solana's fixed fees. The desk does
   not size a stranger's wallet, so there is no number to check; what a tenant must get
   is the CALL. Their bot sizes it from its own FIXED_SOL / MAX_SOL_PER_TRADE and its own
   fee floor (executor/strategy.mjs:232-234, 305). */
ok("...with no size attached, and saying so", d.sizeSol === null && d.sizeBinding === false,
  `sizeSol=${d.sizeSol} sizeBinding=${d.sizeBinding}`);
const res = broadcast(call.id, [FLOOR]);
ok("broadcast delivered to the tenant", res.ok && res.offered === 1, `offered=${res.offered} skipped=${res.skipped}`);
await alerts.announceEntry(call);
const feed = executorFeedPayload(FLOOR, 0);
const ev = (feed.events || []).find((e) => e.call_id === call.id && e.type === "entry");
ok("the tenant's executor feed serves the ENTRY", !!ev, ev ? `symbol=${ev.symbol} size=${ev.size_sol}` : "no event");
/* The wire still CARRIES a size field, for rows written before today and for older
   clients that would break without it — and it is null on everything new, and labelled
   non-binding either way (office.js size_binding). */
ok("...carrying no size, labelled non-binding, with the floor's own rules",
  ev && ev.size_sol == null && ev.size_binding === false && feed.rules
  && feed.rules.size_binding === false && "fixed_sol" in feed.rules,
  ev ? `size ${ev.size_sol}, rules ${JSON.stringify(feed.rules)}` : "");
ok("...and the floor's verdicts ride the feed", Array.isArray(feed.decisions) && feed.decisions[0]?.verdict === "offered",
  feed.decisions?.[0] ? `${feed.decisions[0].symbol} ${feed.decisions[0].verdict}` : "no decisions");
const payload = JSON.stringify(feed).toLowerCase();
for (const forbidden of ["secretkey", "privatekey", "seed", "mnemonic", "keypair"])
  ok(`the tenant feed carries no ${forbidden}`, !payload.includes(forbidden));

console.log("\nA TENANT'S FIXED SIZE IS THEIR OWN BUSINESS, NOT SOMETHING THE DESK ECHOES");
/* This asserted that a tenant stating 0.05 SOL was "offered at least the executable
   minimum" — the desk reading their setting and re-issuing it as a delivered size, which
   made the desk look like the author of a number it had not chosen. The setting is still
   stored (their board renders it, and it is theirs to change); the delivery is silent. */
saveSettings(FLOOR, { fixedSol: 0.05 });
const fixed = decide(FLOOR, call);
ok("a tenant who states 0.05 SOL gets the same sizeless delivery as everyone else",
  fixed.verdict === "offered" && fixed.sizeSol === null && fixed.reason === d.reason,
  `${fixed.verdict} ${fixed.sizeSol}`);
ok("...while their own setting is still stored and still theirs",
  Number(settingsFor(FLOOR).fixed_sol) === 0.05, `fixed_sol=${settingsFor(FLOOR).fixed_sol}`);

console.log("\nTHE EXIT FOLLOWS THE SAME ROAD");
closeCall(call.id, "target_hit", 0.0021);
if (typeof alerts.announceExit === "function") {
  await alerts.announceExit(call, { urgency: "unconditional", code: "target_hit", detail: "target reached — the desk is out" });
  const after = executorFeedPayload(FLOOR, ev?.id ?? 0);
  const exit = (after.events || []).find((e) => e.call_id === call.id && e.type === "exit");
  ok("the tenant's feed serves the EXIT for a call it was offered", !!exit, exit ? `id=${exit.id}` : "no exit event");
  /* Desk-led exits (2026-09-05): the bot sells exactly what the desk determined, and
     reports the desk's print and moment back — so the exit event must carry them. */
  ok("...with the desk's close print and moment", exit?.close_mark === 0.0021 && Number(exit?.closed_at) > 0,
    `close_mark=${exit?.close_mark} closed_at=${exit?.closed_at}`);
  ok("...and the entry carried opened_at for the mirror's clock", Number(ev?.opened_at) > 0, `opened_at=${ev?.opened_at}`);
  const { feedFor } = await import("./src/copy.js");
  const row = feedFor(FLOOR, 5).find((r) => r.call_id === call.id);
  ok("the floor feed row carries the bot fields, null until the bot reports", row && "bot_status" in row && row.bot_status === null,
    `bot_status=${row?.bot_status}`);
  ok("...and no wallet", row && !("wallet" in row));
} else {
  ok("exit announcer is exported", false, "announceExit not found on alerts.js");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
