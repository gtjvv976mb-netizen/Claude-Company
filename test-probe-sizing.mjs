/**
 * THE ROUTE PROBE'S AMOUNT IS A TEST INSTRUMENT, AND IT CAPS NOTHING.
 *
 * WHAT THIS FILE USED TO GUARD. cfg.targetSizeUsd was $75, and that one number was: the
 * notional the exit probe quoted at, an absolute ceiling on position_size_usd in
 * risk-rails, the source of the per-coin minimum stop distance in compliance, and — via
 * copy.js — the SOL cap on every delivery. It was lowered to $15, and this file existed
 * to prove that lowering it did not let a delivery outrun the evidence behind it: "no
 * delivery may be larger than the probe proved exitable".
 *
 * THE CORRECTION (owner, 2026-09-07, stated three times and final). The desk says only
 * WHAT and WHEN. It does not size a trade, cap one, or judge what one costs. Every
 * consumer above is deleted, and the invariant this file was written to defend went with
 * them — there is no delivery size left to bound. Chasing the number from $500 to $200 to
 * $75 to $15 was the tell: each step made the vetoes slightly less wrong and none could
 * make them right, because the desk cannot know a size that lives in the operator's own
 * environment. At $75 it refused a coin at "round-trip loss 8.08% > ceiling 8%" while
 * that bot's real clip was about $2.
 *
 * WHAT IS LEFT, and what this file now proves. Jupiter needs an amount to quote, and the
 * desk asks it one genuine coin-quality question — CAN THIS TOKEN BE SOLD? So the amount
 * survives as a test instrument. It is MEASURED off a live bot's declared per-trade cap
 * rather than chosen, it resolves to a stated constant when there is no bot to read, and
 * NOTHING may veto, cap or size from it.
 *
 *   CLAUDE_CO_DB=/tmp/x.db node test-probe-sizing.mjs
 */
process.env.CLAUDE_CO_DB = process.env.CLAUDE_CO_DB || "/tmp/probe-sizing-test.db";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
if (!process.env.CLAUDE_CO_DB.startsWith("/tmp/probe-sizing")) { /* runner sandbox */ }
else { try { fs.rmSync(process.env.CLAUDE_CO_DB); } catch {} }

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const copy = await import("./src/copy.js");
const probe = await import("./src/probe-size.js");
const db = (await import("./src/lib/store.js")).default;
const { cfg } = await import("./src/config.js");
const { complianceCheck } = await import("./src/agents/compliance.js");
const { enforceRiskRails } = await import("./src/agents/risk-rails.js");

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const FLOOR = 12;
copy.settingsFor(FLOOR);                       // materialise the row
const setFloor = (patch) => copy.saveSettings(FLOOR, patch);
const heartbeat = (floorNo, maxSolPerTrade, ageMs = 0) => {
  copy.settingsFor(floorNo);
  db.prepare("UPDATE copy_settings SET executor_heartbeat=? WHERE floor_no=?").run(
    JSON.stringify({ seenAt: Date.now() - ageMs, health: { caps: { maxSolPerTrade } } }), floorNo);
};
const clearHeartbeats = () => db.prepare("UPDATE copy_settings SET executor_heartbeat=NULL").run();

const call = {
  id: 1, mint: "M", symbol: "PROBE", category: "memecoin", launchpad: "pump.fun",
  conviction: 80, entry_ref: 0.001, stop: 0.00088, target: 0.0014,
  liq_at_call: 200_000, mcap_at_call: 900_000,
  desk_size_usd: 15, desk_equity_usd: 100,
};

console.log("\nTHE DESK NO LONGER HOLDS A SIZE CONSTANT AT ALL");
{
  ok("cfg.targetSizeUsd is gone", cfg.targetSizeUsd === undefined, `cfg.targetSizeUsd = ${cfg.targetSizeUsd}`);
  /* And it is no longer env-settable, which is the half that matters. The old test
     asserted the OPPOSITE — "DESK_TARGET_SIZE_USD overrides it" — because an operator
     was expected to tune the probe. A tunable size constant on the desk is a standing
     invitation to write another veto against it, so setting the variable must now do
     nothing at all. Read in a CHILD process: cfg is frozen at import, so an in-process
     env poke would prove nothing about the number production actually boots with. */
  const { spawnSync } = await import("node:child_process");
  const child = spawnSync(process.execPath,
    ["-e", "import('./src/config.js').then(m => console.log('TARGET=' + m.cfg.targetSizeUsd))"],
    { cwd: ROOT, encoding: "utf8", env: { ...process.env, DESK_TARGET_SIZE_USD: "42" }, timeout: 60_000 });
  ok("...and DESK_TARGET_SIZE_USD no longer does anything",
    /TARGET=undefined\b/.test(child.stdout || ""),
    (child.stdout || child.stderr || "").trim().split("\n").pop());
  const envSrc = fs.readFileSync(new URL("./.env.example", import.meta.url), "utf8");
  ok("...and .env.example says so rather than still advertising it",
    /DESK_TARGET_SIZE_USD[\s\S]{0,400}?were\s*\n?#?\s*removed on 2026-09-07/.test(envSrc)
    || /removed on 2026-09-07/.test(envSrc),
    "the removed knobs are listed as removed");
}

console.log("\nTHE ROUTE PROBE MEASURES THE BOT, AND SAYS SO");
{
  clearHeartbeats();
  heartbeat(FLOOR, 0.02);
  const measured = probe.botProbeNotional();
  ok("with a live bot the amount comes from its declared cap",
    measured.fromBot === true && measured.botSol === 0.02,
    `$${measured.sizeUsd} — ${measured.source}`);
  ok("...converted at a SOL price whose provenance is named",
    measured.solUsd > 0 && typeof measured.solUsdSource === "string" && measured.solUsdSource.length > 0,
    `SOL $${measured.solUsd} (${measured.solUsdSource})`);

  /* The LARGEST live cap, not the average or the nearest — the most representative real
     amount available when one quote is shared across every floor. */
  heartbeat(41, 0.045);
  const across = probe.botProbeNotional();
  ok("across floors it reads the largest live cap", across.botSol === 0.045 && across.botFloorNo === 41,
    across.why);

  clearHeartbeats();
  const fallback = probe.botProbeNotional();
  ok("with no bot reporting it falls back to a STATED constant, never to zero",
    fallback.fromBot === false && fallback.sizeUsd === probe.ROUTE_PROBE_FALLBACK_USD
    && fallback.sizeUsd > 0,
    `$${fallback.sizeUsd} — ${fallback.source}`);
  ok("...and the constant is a plain export, not a config knob",
    probe.ROUTE_PROBE_FALLBACK_USD === 15 && cfg.targetSizeUsd === undefined,
    `ROUTE_PROBE_FALLBACK_USD = ${probe.ROUTE_PROBE_FALLBACK_USD}`);

  const stale = (heartbeat(FLOOR, 0.02, 25 * 3_600e3), probe.botProbeNotional());
  ok("a 25h-old heartbeat is not a live bot",
    stale.fromBot === false && /25h old|is 25h old|heartbeat is/.test(stale.why), stale.why);
}

console.log("\nTHE AMOUNT REACHES NO SIZE, NO CAP AND NO VETO");
{
  clearHeartbeats();
  heartbeat(FLOOR, 0.02);                       // ~$2 at the fallback SOL price
  const measured = probe.botProbeNotional({ floorNo: FLOOR });

  /* THE DELIVERY. The old assertion here was "a 0.4 SOL fixed size is delivered at the
     cap, not at 0.4". There is no cap and no delivered size: whatever the tenant has
     configured, the desk sends the coin and says nothing about the amount. */
  setFloor({ appetite: "aggressive", bankrollSol: 2, fixedSol: 0.4 });
  const big = copy.decide(FLOOR, call);
  setFloor({ fixedSol: 0.001 });
  const small = copy.decide(FLOOR, call);
  ok("a floor asking 0.4 SOL and a floor asking 0.001 get the same delivery",
    big.verdict === "offered" && small.verdict === "offered"
    && big.sizeSol === null && small.sizeSol === null,
    `0.4 -> ${big.sizeSol}, 0.001 -> ${small.sizeSol}`);
  ok("...marked non-binding, in the field and in words",
    big.sizeBinding === false && /your bot sizes this trade from its own caps/.test(big.reason),
    big.reason);
  /* The reason may SAY the desk does not cap or judge fees — that sentence is the point.
     What it must not carry is a NUMBER anyone could act on: no SOL amount, no dollar
     figure, no cap. The old reason strings quoted all three ("capped to 0.1456 SOL — the
     desk's exit probe measures a round trip at $15... You set 0.4 SOL"). */
  ok("...and the delivery quotes no SOL amount and no dollar figure",
    !/\d[\d.]*\s*SOL/i.test(big.reason) && !/\$\s*\d/.test(big.reason), big.reason);

  /* THE RAILS. risk-rails used to clamp position_size_usd to the probed notional and
     compliance used to veto above it. Prove a size far above the probe now survives
     both — it is the desk's own paper record, judged only against the desk's own book. */
  const ev = { pair: { priceUsd: 1 }, exitProbe: { targetSizeUsd: measured.sizeUsd, roundTripLossPct: 3 } };
  const railed = enforceRiskRails({ risk: { stop_price: 0.75, risk_tier: "full", confidence: 1 },
    ev, redteam: { verdict: "survived" } });
  ok(`risk-rails sizes above the $${measured.sizeUsd} probe without clamping to it`,
    railed.position_size_usd > measured.sizeUsd * 2,
    `$${railed.position_size_usd} — ${railed.rail_notes.join("; ")}`);
  ok("...and no note claims an exit-probe cap",
    !railed.rail_notes.some((n) => /exit-probe|exit probe/.test(n)), railed.rail_notes.join("; "));

  const checked = complianceCheck({
    pm: { decision: "PROPOSE" }, redteam: { verdict: "survived" },
    risk: railed, ticket: { entry_zone_low: 1, entry_zone_high: 1.02, stop_price: railed.stop_price,
      take_profit: [{ price: 1.01, pct_to_sell: 100 }] }, ev });
  ok("...and compliance raises no size or cost veto on it",
    !checked.violations.some((v) => ["size_exceeds_exit_probe", "stop_inside_costs", "edge_below_cost"].includes(v.code)),
    checked.violations.map((v) => v.code).join(",") || "no violations");
}

console.log("\nTHE HELPERS THAT ONLY EXISTED TO CAP ARE GONE");
{
  ok("copy.probeSizeCapSol no longer exists", copy.probeSizeCapSol === undefined);
  ok("copy.probeSizingMismatch no longer exists", copy.probeSizingMismatch === undefined);
  ok("src/probe-notional.js is deleted",
    !fs.existsSync(new URL("./src/probe-notional.js", import.meta.url)),
    "its only readers were the two size vetoes");
  /* probeSizingForFloor SURVIVES, because the owner has to be able to SEE that size is
     the bot's — a rule nobody can observe is a rule that quietly stops holding. It must
     carry no number anyone could mistake for an instruction. */
  clearHeartbeats(); heartbeat(FLOOR, 0.02);
  const shown = copy.probeSizingForFloor(FLOOR);
  ok("probeSizingForFloor still reports WHO sizes the trade",
    shown.sizeAuthority === "bot" && shown.probeIsRouteTestOnly === true, JSON.stringify({
      sizeAuthority: shown.sizeAuthority, probeSizeUsd: shown.probeSizeUsd }));
  ok("...and carries no advisory cap for a client to honour",
    !("advisoryCapSol" in shown) && !Object.keys(shown).some((k) => /cap/i.test(k)),
    Object.keys(shown).join(", "));
  ok("...and tells the tenant in words that the amount is a test, not a trade",
    /test amount, not a trade amount/.test(shown.note), shown.note);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
