import { runCycle, workup } from "./desk.js";
import { startOffice } from "./office.js";
import { startScanner } from "./scanner.js";
import { runPenthouseCycle, monitorCalls, freshScan, promoteWatches } from "./penthouse.js";
import { autoSyncAll, collectOwed } from "./perf.js";
import { startWorld } from "./world.js";
import { chroniclePrune } from "./lib/bus.js";
import { chargeDueRent, settleArrears } from "./leasing.js";
import { bus } from "./lib/bus.js";
import { spend } from "./lib/llm.js";
import * as store from "./lib/store.js";
import db from "./lib/store.js";
import * as sol from "./data/solana.js";
import { cfg, maskRpc } from "./config.js";

const [, , cmd, ...args] = process.argv;

const C = { dim: "\x1b[2m", b: "\x1b[1m", g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[31m", c: "\x1b[36m", x: "\x1b[0m" };

function narrate() {
  bus.on("event", (e) => {
    const t = new Date(e.ts).toLocaleTimeString();
    const line = {
      "cycle:start": () => `${C.b}▶ cycle ${e.cycle}${C.x}`,
      "scout:universe": () => `${C.c}SCOUT${C.x} universe ${e.total} → ${e.fresh} fresh`,
      "scout:shortlist": () => `${C.c}SCOUT${C.x} shortlist: ${e.count}`,
      "scout:skip": () => `${C.dim}skip ${e.mint.slice(0, 6)} — ${e.reason}${C.x}`,
      "token:start": () => `\n${C.b}── ${e.mint.slice(0, 8)}…${C.x} ${C.dim}${e.hook || ""}${C.x}`,
      "token:evidence": () => `   evidence: ${e.symbol} $${e.price} liq $${Math.round(e.liq || 0).toLocaleString()}`,
      "seat:thinking": () => `${C.dim}   ${e.seat} thinking…${C.x}`,
      "seat:searching": () => `${C.dim}   ${e.seat} searching the web…${C.x}`,
      "seat:verdict": () => `   ${C.y}${e.seat}${C.x}: ${e.detail ?? ""}${e.score != null ? ` ${e.score}/100` : ""}${e.kill ? ` ${C.r}KILL${C.x}` : ""}${e.pass === false ? ` ${C.r}FAIL${C.x}` : ""}`,
      "seat:failed": () => `   ${C.r}${e.seat} failed${C.x}: ${e.error}`,
      "token:end": () => `   ${C.b}→ ${e.outcome}${C.x}${e.report ? ` ${C.dim}${e.report}${C.x}` : ""}`,
      "cycle:end": () => `\n${C.b}■ cycle done${C.x} — ${e.count ?? 0} tokens, $${e.spendUsd ?? 0} spent`,
    }[e.type];
    if (line) console.log(`${C.dim}${t}${C.x} ${line()}`);
  });
}

/**
 * The penthouse works on a schedule. Research is expensive, so it runs a few times a day;
 * monitoring open calls is free of model calls, so it runs often — an exit trigger that
 * fires six hours late is not an exit trigger.
 */
/** The books run whether or not the brain does. Rent and fill-syncing are pure
 * accounting — no model calls — and used to sit behind the penthouse guard, which
 * meant a server without an API key also silently stopped charging rent. */
function startBooks() {
  const rent = () => {
    try { const r = chargeDueRent();
      if (r.charged || r.unpaid) console.log(`[rent] charged ${r.charged}, in arrears ${r.unpaid}`);
    } catch (e) { console.log(`[rent] ${e.message}`); }
    // Retry what could not be collected before: unpaid rent against topped-up
    // balances, and performance fees that settled while the balance was short.
    try { const a = settleArrears();
      if (a.settled) console.log(`[rent] cleared ${a.settled} arrears (${a.remaining} remain)`);
    } catch (e) { console.log(`[rent] arrears: ${e.message}`); }
    try {
      const owed = dbOwedWallets();
      for (const w of owed) collectOwed(w).catch(() => {});
    } catch (e) { console.log(`[fees] ${e.message}`); }
  };
  setInterval(rent, 3600000);
  setTimeout(rent, 30000);
  setInterval(() => chroniclePrune(), 3600000);

  const sync = async () => {
    try { const r = await autoSyncAll();
      if (r.fills || r.settled) console.log(`[books] synced ${r.floors} floors: ${r.fills} fills, ${r.settled} settled`);
    } catch (e) { console.log(`[books] ${e.message}`); }
  };
  const syncMins = Number(process.env.BOOKS_SYNC_MINS || 10);
  setInterval(sync, syncMins * 60000);
  setTimeout(sync, 45000);
  console.log(`[books] rent hourly, fill sync every ${syncMins}m`);
}

function startMonitoring() {
  const monitorMins = Number(process.env.PENTHOUSE_MONITOR_MINS || 10);
  const watch = async () => {
    try { const r = await monitorCalls();
      if (r.closed) console.log(`[monitor] closed ${r.closed} of ${r.checked} open calls`);
    } catch (e) { console.log(`[monitor] failed: ${e.message}`); }
  };
  setInterval(watch, monitorMins * 60000);
  setTimeout(watch, 20000);
  console.log(`[monitor] exit checks every ${monitorMins}m — key or no key`);
}

function dbOwedWallets() {
  return db.prepare("SELECT DISTINCT wallet FROM results WHERE fee_paid=0 AND fee_usd>0").all()
    .map((r) => r.wallet);
}

function startPenthouse() {
  const cycleMins = Number(process.env.PENTHOUSE_CYCLE_MINS || 360);   // 4x a day
  const monitorMins = Number(process.env.PENTHOUSE_MONITOR_MINS || 10);
  if (process.env.PENTHOUSE_ENABLED === "0") { console.log("[penthouse] disabled"); return; }
  if (!process.env.ANTHROPIC_API_KEY) { console.log("[penthouse] no API key — the house team cannot work"); return; }

  const research = async () => {
    try { const r = await runPenthouseCycle();
      console.log(`[penthouse] cycle: ${r.considered} seen, ${r.workedUp} worked up, ${r.opened} calls, $${r.costUsd}`);
    } catch (e) { console.log(`[penthouse] cycle failed: ${e.message}`); }
  };
  setTimeout(research, 15000);                      // let the server settle first
  setInterval(research, cycleMins * 60000);

  // The sniper lane: cheap, frequent, and only ever pays for ignition.
  const freshMins = Number(process.env.PENTHOUSE_FRESH_MINS || 20);
  const fresh = async () => {
    try { const r = await freshScan();
      if (r.workedUp) console.log(`[fresh] worked up the top ignition: ${r.outcome}`);
      // A lane that dies silently is a lane that is dead for weeks — this line
      // is how "cfg is not defined" would have been caught on day one.
      if (r.error) console.log(`[fresh] scan error: ${r.error}`);
      if (r.halted) console.log(`[fresh] ${r.halted}`);
    } catch (e) { console.log(`[fresh] ${e.message}`); }
  };
  setTimeout(fresh, 90000);
  setInterval(fresh, freshMins * 60000);

  // The criteria, acted on: watches whose rules hold go back through the desk.
  const promoteMins = Number(process.env.PENTHOUSE_WATCH_MINS || 10);
  const promote = async () => {
    try { const r = await promoteWatches();
      if (r.workedUp) console.log(`[watch] promoted ${r.outcome} (${r.checked} watched)`);
      if (r.error) console.log(`[watch] ${r.error}`);
      if (r.halted) console.log(`[watch] ${r.halted}`);
    } catch (e) { console.log(`[watch] ${e.message}`); }
  };
  setTimeout(promote, 120000);
  setInterval(promote, promoteMins * 60000);
  console.log(`[penthouse] research every ${cycleMins}m, fresh scan every ${freshMins}m, watch checks every ${promoteMins}m`);
}

async function main() {
  switch (cmd) {
    case "doctor": {
      console.log(`${C.b}Claude Company doctor${C.x}`);
      // "set" is not the same as "usable" — a copied placeholder looks set and 401s.
      const key = process.env.ANTHROPIC_API_KEY || "";
      const keyState = !key ? C.r + "MISSING" + C.x
        : key.length < 40 || key.includes("...") ? C.r + "PLACEHOLDER — replace it with the real key" + C.x
        : !key.startsWith("sk-ant-") ? C.y + "unexpected format (should start sk-ant-)" + C.x
        : C.g + `set (${key.length} chars)` + C.x;
      console.log(`  API key      : ${keyState}`);
      if (key.length >= 40 && key.startsWith("sk-ant-")) {
        try {
          const Anthropic = (await import("@anthropic-ai/sdk")).default;
          const r = await new Anthropic().messages.create({
            model: "claude-opus-5", max_tokens: 8,
            messages: [{ role: "user", content: "say: ok" }],
          });
          console.log(`  API call     : ${C.g}works${C.x} (${r.model})`);
        } catch (e) {
          console.log(`  API call     : ${C.r}${e.status || ""} ${String(e.message).slice(0, 80)}${C.x}`);
        }
      }
      console.log(`  Treasury     : ${process.env.TREASURY_OWNER ? C.g + "set — leasing open" + C.x : C.y + "not set — leasing closed" + C.x}`);
      console.log(`  RPC          : ${maskRpc()}`);
      const h = await sol.health();
      console.log(`  RPC reachable: ${h.ok ? C.g + "yes (slot " + h.slot + ")" + C.x : C.r + h.error + C.x}`);
      // Holder concentration is the datum the red team called dominant. The public RPC
      // blocks the call outright, so flag it here rather than letting every workup lose
      // it silently mid-run.
      const holderProbe = await import("./lib/http.js").then(({ readRpc }) =>
        readRpc(cfg.rpc, "getTokenLargestAccounts",
          ["DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"], { attempts: 1 }));
      console.log(`  Holder data  : ${holderProbe.ok
        ? C.g + "available" + C.x
        : C.r + `UNAVAILABLE (${holderProbe.error}) — set SOLANA_RPC to a paid endpoint or every workup loses holder concentration` + C.x}`);
      console.log(`  Book equity  : $${cfg.equityUsd}  |  max risk/idea ${cfg.maxRiskPct}%`);
      console.log(`  Screen floors: liq $${cfg.screen.minLiquidityUsd}, age ${cfg.screen.minPairAgeHours}h, vol $${cfg.screen.minVolume24hUsd}`);
      const { spendSince } = await import("./lib/llm.js");
      const day = spendSince(Date.now() - 86400000), all = spendSince(0);
      console.log(`  Spend 24h    : $${day.usd} over ${day.calls} calls   |  all time: $${all.usd} over ${all.calls}`);
      console.log(`  Journal      : ${JSON.stringify(store.stats())}`);
      break;
    }
    case "office": {
      const { url } = startOffice(Number(args[0]) || Number(process.env.PORT) || 4949);
      startScanner();          // watches the treasury for $CLAUDECO; no-ops until TREASURY_OWNER is set
      startBooks();            // rent + fill sync, always
      startWorld();            // the server runs the office; clients only watch
      startMonitoring();       // exit checks are a DUTY: they run with no key and no research
      startPenthouse();        // the house team's schedule
      console.log(`${C.b}Trading floor live at ${url}${C.x}  (Ctrl-C to close)`);
      narrate();
      break;
    }
    case "one": {
      if (!args[0]) { console.error("usage: npm run one -- <mint> [--office]"); process.exit(1); }
      if (args.includes("--office")) {
        const { url } = startOffice();
        console.log(`${C.b}Trading floor: ${url}${C.x}`);
        await new Promise((r) => setTimeout(r, 1500));
      }
      narrate();
      const r = await workup(new Date().toISOString().replace(/[:.]/g, "-"), args[0], "operator-specified");
      console.log(`\n${C.b}Outcome:${C.x} ${r.finalDecision || r.outcome}`);
      if (r.reportFile) console.log(`Report: ${r.reportFile}`);
      const { spend } = await import("./lib/llm.js");
      console.log(`${C.b}Cost:${C.x} $${spend.usd.toFixed(4)}  ` +
        `(${spend.calls} calls, ${spend.inTok.toLocaleString()} in / ${spend.outTok.toLocaleString()} out` +
        `${spend.cachedTok ? `, ${spend.cachedTok.toLocaleString()} cached` : ""})`);
      if (!args.includes("--office")) process.exit(0);
      break;
    }
    case "ledger": {
      const rows = store.ledger(30);
      if (!rows.length) { console.log("No proposals yet."); break; }
      console.log(`${C.b}date                 symbol    decision   conviction  size      stop${C.x}`);
      for (const r of rows) {
        console.log(
          `${new Date(r.ts).toISOString().slice(0, 16)}  ${String(r.symbol).padEnd(9)} ${String(r.decision).padEnd(10)} ` +
          `${String(r.conviction ?? "").padEnd(11)} $${String(r.size_usd ?? "").padEnd(8)} ${r.stop ?? ""}`
        );
      }
      console.log(`\n${JSON.stringify(store.stats(), null, 2)}`);
      break;
    }
    case "watch": {
      const mins = Number(args[0]) || 30;
      const { url } = startOffice();
      console.log(`${C.b}Trading floor: ${url}${C.x} — cycling every ${mins} min`);
      narrate();
      const loop = async () => {
        try { await runCycle({}); } catch (e) { console.error(C.r + String(e?.message || e) + C.x); }
        console.log(`${C.dim}next cycle in ${mins}m — total spend $${spend.usd.toFixed(4)}${C.x}`);
      };
      await loop();
      setInterval(loop, mins * 60_000);
      break;
    }
    case "run":
    default: {
      if (args.includes("--office")) {
        const { url } = startOffice();
        console.log(`${C.b}Trading floor: ${url}${C.x}`);
        await new Promise((r) => setTimeout(r, 1500));
      }
      narrate();
      await runCycle({ limit: Number(process.env.DESK_MAX_CANDIDATES) || cfg.maxCandidates });
      console.log(`\nSpend: $${spend.usd.toFixed(4)} over ${spend.calls} calls`);
      if (!args.includes("--office")) process.exit(0);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
