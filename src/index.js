import { runCycle, workup } from "./desk.js";
import { startOffice } from "./office.js";
import { startScanner } from "./scanner.js";
import { bus } from "./lib/bus.js";
import { spend } from "./lib/llm.js";
import * as store from "./lib/store.js";
import * as sol from "./data/solana.js";
import { cfg } from "./config.js";

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

async function main() {
  switch (cmd) {
    case "doctor": {
      console.log(`${C.b}Claude Company doctor${C.x}`);
      console.log(`  API key      : ${process.env.ANTHROPIC_API_KEY ? C.g + "set" + C.x : C.r + "MISSING" + C.x}`);
      console.log(`  RPC          : ${cfg.rpc}`);
      const h = await sol.health();
      console.log(`  RPC reachable: ${h.ok ? C.g + "yes (slot " + h.slot + ")" + C.x : C.r + h.error + C.x}`);
      console.log(`  Book equity  : $${cfg.equityUsd}  |  max risk/idea ${cfg.maxRiskPct}%`);
      console.log(`  Screen floors: liq $${cfg.screen.minLiquidityUsd}, age ${cfg.screen.minPairAgeHours}h, vol $${cfg.screen.minVolume24hUsd}`);
      console.log(`  Journal      : ${JSON.stringify(store.stats())}`);
      break;
    }
    case "office": {
      const { url } = startOffice(Number(args[0]) || Number(process.env.PORT) || 4949);
      startScanner();          // watches the treasury for $CLAUDECO; no-ops until TREASURY_OWNER is set
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
