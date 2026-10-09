#!/usr/bin/env node
/**
 * TREND STUDY — did the trend lane make money, on paper and for real, and where.
 *
 *   node docs/handoff/tools/trend-study.mjs [--dir ~/claudeco-executor] [--state-db PATH]
 *                                            [--shadow FILE] [--live FILE]
 *                                            [--since 24h|7d|2026-09-30T00:00Z] [--json]
 *
 * Zero dependencies (Node 18+). Runs on the Mac, or anywhere the two JSONL files were copied.
 * It reads the files the lane writes beside the journal (executor/snipe-trend.mjs and
 * executor/snipe-trend-live.mjs; the journal is $STATE_DB = ~/claudeco-executor/.cc-executor.sqlite
 * on an installed Mac):
 *
 *   <STATE_DB>.trend-shadow.jsonl   one row per closed PAPER trade — every related launch the
 *                                   lane followed, variants and subtopics alike (strategy: true
 *                                   marks the kinds the live lane would trade)
 *   <STATE_DB>.trend-live.jsonl     one row per closed REAL trade — the strategy's kinds only,
 *                                   realizedSol read from the chain (null = not read; a row with
 *                                   reconciled: true left the wallet outside the lane's sight)
 *
 * For each file: count, wins/losses, total and mean P&L, win rate, best and worst, by kind, by
 * exit reason, by parent coin, by UTC day. Then paper against real, matched by mint, so the
 * cost of being real (slippage, landing later, a sell that paper never failed) has a number.
 *
 * A row that cannot be read is skipped and counted, never guessed at.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt; };
const JSON_OUT = args.includes("--json");
const home = (p) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);

/* Where the files are: explicit paths win, then STATE_DB, then a shallow search of the install dir. */
function findFiles() {
  const stateDb = opt("--state-db", null);
  const dir = home(opt("--dir", "~/claudeco-executor"));
  const want = { shadow: opt("--shadow", null), live: opt("--live", null) };
  if (stateDb) {
    want.shadow ??= `${home(stateDb)}.trend-shadow.jsonl`;
    want.live ??= `${home(stateDb)}.trend-live.jsonl`;
  }
  if (!want.shadow || !want.live) {
    const found = { shadow: null, live: null };
    const walk = (d, depth) => {
      let entries = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isFile() && e.name.endsWith(".trend-shadow.jsonl")) found.shadow ??= p;
        else if (e.isFile() && e.name.endsWith(".trend-live.jsonl")) found.live ??= p;
        else if (e.isDirectory() && depth > 0 && !["node_modules", "versioned-releases", "releases"].includes(e.name)) walk(p, depth - 1);
      }
    };
    walk(dir, 2);
    want.shadow ??= found.shadow;
    want.live ??= found.live;
  }
  return want;
}

function sinceMs() {
  const s = opt("--since", null);
  if (!s) return 0;
  const m = /^(\d+)\s*([hdw])$/i.exec(s);
  if (m) return Date.now() - Number(m[1]) * { h: 3600e3, d: 86400e3, w: 7 * 86400e3 }[m[2].toLowerCase()];
  const t = Date.parse(s);
  if (!Number.isFinite(t)) { console.error(`--since: cannot read "${s}" (use 24h, 7d, or an ISO date)`); process.exit(2); }
  return t;
}

function readRows(file, kind, since) {
  if (!file) return { file: null, rows: [], skipped: 0 };
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { return { file, rows: [], skipped: 0, error: e.message }; }
  const rows = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { skipped++; continue; }
    if (!r || typeof r !== "object") { skipped++; continue; }
    const exitAtMs = Number(r.exitAtMs ?? r.closedAtMs ?? NaN);
    if (!Number.isFinite(exitAtMs)) { skipped++; continue; }
    if (exitAtMs < since) continue;
    const pnl = kind === "live" ? r.realizedSol : r.pnlSol;
    rows.push({
      mint: String(r.mint ?? "?"), symbol: String(r.symbol ?? "?"),
      kind: String(r.kind ?? "?"),
      parent: typeof r.parent === "object" && r.parent ? String(r.parent.symbol ?? r.parent.mint ?? "?") : String(r.parent ?? "?"),
      strategy: kind === "live" ? true : r.strategy === true,
      reason: String(r.reason ?? "?").replace(/:.*$/, "").slice(0, 40),
      pnlSol: pnl === null || pnl === undefined || !Number.isFinite(Number(pnl)) ? null : Number(pnl),
      netPct: Number.isFinite(Number(r.netPct)) ? Number(r.netPct) : null,
      exitX: Number.isFinite(Number(r.exitX)) ? Number(r.exitX) : null,
      peakX: Number.isFinite(Number(r.peakX)) ? Number(r.peakX) : null,
      holdMs: Number.isFinite(Number(r.holdMs)) ? Number(r.holdMs) : null,
      exitAtMs, reconciled: r.reconciled === true,
      exitSignature: r.exitSignature ?? null,
    });
  }
  rows.sort((a, b) => a.exitAtMs - b.exitAtMs);
  return { file, rows, skipped };
}

const r6 = (n) => Math.round(n * 1e6) / 1e6;
function tally(rows) {
  const read = rows.filter((r) => r.pnlSol !== null);
  const wins = read.filter((r) => r.pnlSol > 0).length;
  const losses = read.filter((r) => r.pnlSol < 0).length;
  const sum = read.reduce((a, r) => a + r.pnlSol, 0);
  return {
    n: rows.length, read: read.length, unread: rows.length - read.length,
    wins, losses, flat: read.length - wins - losses,
    winRatePct: read.length ? Math.round((wins / read.length) * 1000) / 10 : null,
    pnlSol: r6(sum), meanSol: read.length ? r6(sum / read.length) : null,
    bestSol: read.length ? r6(Math.max(...read.map((r) => r.pnlSol))) : null,
    worstSol: read.length ? r6(Math.min(...read.map((r) => r.pnlSol))) : null,
    medianHoldMin: (() => { const h = rows.map((r) => r.holdMs).filter((x) => x !== null).sort((a, b) => a - b); return h.length ? Math.round(h[Math.floor(h.length / 2)] / 6000) / 10 : null; })(),
    from: rows.length ? new Date(rows[0].exitAtMs).toISOString() : null,
    to: rows.length ? new Date(rows[rows.length - 1].exitAtMs).toISOString() : null,
  };
}
function groupBy(rows, key, limit = 12) {
  const m = new Map();
  for (const r of rows) { const k = key(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  return [...m.entries()].map(([k, xs]) => ({ key: k, ...tally(xs) }))
    .sort((a, b) => b.n - a.n).slice(0, limit);
}
function study(rows) {
  return {
    all: tally(rows),
    strategy: tally(rows.filter((r) => r.strategy)),
    comparison: tally(rows.filter((r) => !r.strategy)),
    byKind: groupBy(rows, (r) => r.kind),
    byReason: groupBy(rows, (r) => r.reason),
    byParent: groupBy(rows, (r) => r.parent, 10),
    byDay: groupBy(rows, (r) => new Date(r.exitAtMs).toISOString().slice(0, 10), 31).sort((a, b) => a.key.localeCompare(b.key)),
  };
}

function compare(live, shadow) {
  const paper = new Map(shadow.map((r) => [r.mint, r]));
  const pairs = live.filter((r) => paper.has(r.mint)).map((r) => {
    const p = paper.get(r.mint);
    return { mint: r.mint, symbol: r.symbol, realSol: r.pnlSol, paperSol: p.pnlSol, gapSol: r.pnlSol === null || p.pnlSol === null ? null : r6(r.pnlSol - p.pnlSol), realReason: r.reason, paperReason: p.reason, reconciled: r.reconciled };
  });
  const gaps = pairs.filter((x) => x.gapSol !== null);
  return {
    matched: pairs.length, unmatched: live.length - pairs.length,
    realSol: r6(gaps.reduce((a, x) => a + x.realSol, 0)),
    paperSol: r6(gaps.reduce((a, x) => a + x.paperSol, 0)),
    gapSol: r6(gaps.reduce((a, x) => a + x.gapSol, 0)),
    meanGapSol: gaps.length ? r6(gaps.reduce((a, x) => a + x.gapSol, 0) / gaps.length) : null,
    disagreeOnWin: gaps.filter((x) => (x.realSol > 0) !== (x.paperSol > 0)).length,
    rows: pairs,
  };
}

const since = sinceMs();
const files = findFiles();
const shadow = readRows(files.shadow, "shadow", since);
const live = readRows(files.live, "live", since);
const out = {
  readAt: new Date().toISOString(), since: since ? new Date(since).toISOString() : null,
  shadow: { file: shadow.file, error: shadow.error ?? null, skipped: shadow.skipped, ...study(shadow.rows) },
  live: { file: live.file, error: live.error ?? null, skipped: live.skipped, ...study(live.rows),
    recent: live.rows.slice(-10).reverse() },
  paperVsReal: compare(live.rows, shadow.rows),
};

if (JSON_OUT) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

const sol = (n) => (n === null ? "?" : (n >= 0 ? "+" : "") + n.toFixed(4));
const line = (t, label) => `${label.padEnd(22)} ${String(t.n).padStart(4)} trades  ${String(t.wins).padStart(3)}W ${String(t.losses).padStart(3)}L ${String(t.flat).padStart(2)}= ${String(t.unread).padStart(2)}?  win ${t.winRatePct === null ? "  ?" : String(t.winRatePct).padStart(5)}%  P&L ${sol(t.pnlSol).padStart(8)} SOL  mean ${sol(t.meanSol)}  best ${sol(t.bestSol)}  worst ${sol(t.worstSol)}  hold ~${t.medianHoldMin ?? "?"} min`;
function section(name, s) {
  console.log(`\n== ${name}: ${s.file ?? "no file found"}${s.error ? ` (${s.error})` : ""}${s.skipped ? `  [${s.skipped} unreadable rows skipped]` : ""}`);
  if (!s.all.n) { console.log("   no rows in the window"); return; }
  console.log(`   ${s.all.from} → ${s.all.to}`);
  console.log(line(s.all, "   all"));
  if (s.comparison.n) { console.log(line(s.strategy, "   strategy (kinds)")); console.log(line(s.comparison, "   comparison (rest)")); }
  for (const g of s.byKind) console.log(line(g, `   kind ${g.key}`));
  console.log("   by exit reason:");
  for (const g of s.byReason) console.log(line(g, `     ${g.key}`));
  console.log("   by parent (most traded first):");
  for (const g of s.byParent) console.log(line(g, `     ${g.key}`));
  console.log("   by day (UTC):");
  for (const g of s.byDay) console.log(line(g, `     ${g.key}`));
}
console.log(`trend study, read ${out.readAt}${out.since ? `, rows closed since ${out.since}` : ", all rows"}`);
section("PAPER (shadow lane)", out.shadow);
section("REAL (live lane)", out.live);
if (out.live.recent.length) {
  console.log("   last real trades:");
  for (const r of out.live.recent) console.log(`     ${new Date(r.exitAtMs).toISOString()}  ${r.symbol.padEnd(10)} ${r.kind.padEnd(8)} of ${r.parent.padEnd(10)} ${sol(r.pnlSol).padStart(8)} SOL  ${r.reason}${r.reconciled ? "  (reconciled: left outside the lane)" : ""}`);
}
const c = out.paperVsReal;
console.log(`\n== PAPER vs REAL, matched by mint: ${c.matched} matched, ${c.unmatched} real trades with no paper row`);
if (c.matched) {
  console.log(`   real ${sol(c.realSol)} SOL vs paper ${sol(c.paperSol)} SOL on the same coins → being real cost ${sol(c.gapSol)} SOL (${sol(c.meanGapSol)} per trade); ${c.disagreeOnWin} trade(s) won on paper and lost for real or the reverse`);
  for (const x of c.rows.slice(-12)) console.log(`     ${x.symbol.padEnd(10)} real ${sol(x.realSol).padStart(8)} (${x.realReason})  paper ${sol(x.paperSol).padStart(8)} (${x.paperReason})  gap ${sol(x.gapSol)}`);
}
