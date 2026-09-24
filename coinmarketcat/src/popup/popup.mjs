/**
 * THE POPUP: A WINDOW ONTO THE ENGINE'S STATUS, AND THE SWITCH.
 *
 * Everything shown is `engine.status()` as the service worker hands it over; nothing is
 * computed here that the lane does not already know. The one thing this page does that
 * matters is the arming ceremony: the lane prints the sentence for the connected wallet,
 * the user puts it in the box, and the worker compares the two byte for byte.
 */
import { UI } from "../lib/protocol.mjs";

const $ = (id) => document.getElementById(id);
const send = (type, payload = {}) => chrome.runtime.sendMessage({ type, ...payload });
const short = (k) => (typeof k === "string" && k.length > 12 ? `${k.slice(0, 4)}…${k.slice(-4)}` : String(k ?? "—"));
const fmtSol = (n, d = 4) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? "not read" : `${Number(n) >= 0 ? "+" : ""}${Number(n).toFixed(d)} SOL`);
const ago = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${s % 60}s` : `${Math.floor(s / 3600)}h`; };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let status = null;
let chosenLane = null;
let toastTimer = null;

function toast(text) {
  let t = document.querySelector(".toast");
  if (!t) { t = document.createElement("div"); t.className = "toast"; document.body.appendChild(t); }
  t.textContent = text;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 4_000);
}

function render() {
  if (!status) return;
  const s = status;
  const now = Date.now();
  const pill = $("lanePill");
  pill.textContent = s.executing ? "LIVE" : s.lane === "execute" ? "execute — not armed" : s.lane;
  pill.className = `pill ${s.executing ? "execute" : s.lane === "execute" ? "armq" : s.lane}`;

  $("walletLine").textContent = s.wallet ? s.wallet : s.bridgeReady ? "console open — not connected" : "open the console page first";
  $("btnConnect").disabled = !s.bridgeReady;
  $("feedLine").textContent = `${s.feed?.state ?? "stopped"}${s.feed?.counters?.notifications ? ` · ${s.feed.counters.notifications} logs` : ""}`;
  $("rpcLine").textContent = s.rpc ? (() => { try { return new URL(s.rpc).host; } catch { return "set"; } })() : "not set";

  if (chosenLane === null) chosenLane = s.lane;
  for (const b of document.querySelectorAll("#laneSeg button")) b.classList.toggle("on", b.dataset.lane === chosenLane);
  const arm = s.armability;
  const showArm = chosenLane === "execute" && !s.executing;
  $("armBox").classList.toggle("hidden", !showArm);
  if (arm) {
    $("checklist").innerHTML = arm.items.map((i) => `<li class="${i.ok ? "ok" : ""}"><b>${esc(i.name.replace(/_/g, " "))}</b> — ${esc(i.detail)}</li>`).join("");
    $("expectedAck").textContent = arm.expectedAck ?? "connect Phantom on the console page to see the sentence";
    $("btnArm").disabled = !arm.expectedAck;
    $("warnings").innerHTML = (arm.warnings ?? []).map((w) => `<li>${esc(w.detail)}</li>`).join("");
  }
  $("laneHint").textContent = s.executing
    ? `Armed. ${s.entryInFlight ? `A Phantom window is open for ${short(s.entryInFlight)}.` : "Waiting for a launch that clears the gates and holds up for the wait."}`
    : chosenLane === "observe" ? "Observe: every launch is evaluated and a would-have position is sampled forward. Nothing is signed."
      : chosenLane === "execute" ? "Execute: once the checklist is green and the sentence matches, each cleared launch that still marks above its would-have fill after the wait becomes one Phantom window."
        : "Off constructs nothing.";

  $("dayLine").textContent = `${Number(s.deployedTodaySol ?? 0).toFixed(4)} / ${s.dailySolCap} SOL`;
  $("ticketLine").textContent = `${s.maxSolPerTrade} SOL`;
  $("waitLine").textContent = `${Math.round((s.entryWaitMs ?? 0) / 1000)}s · ≥${s.entryFollowThroughX}x`;

  const open = s.open ?? [];
  $("positions").innerHTML = open.length ? open.map((p) => {
    const cls = p.live ? "live" : "";
    const pend = p.pendingSell ? "pending" : "";
    const state = p.graduated ? "graduated — SELL BY HAND" : p.pendingSell ? `APPROVE THE SELL IN PHANTOM — ${esc(p.pendingSell.reason)}` : p.waitedOut ? `not bought: ${esc(p.waitedOut)}` : p.live ? "held" : p.liveAttempted ? "watched (attempted)" : "watching";
    return `<div class="item ${cls} ${pend}" data-mint="${esc(p.mint)}">
      <div class="t">${esc(p.symbol ?? short(p.mint))} <span class="tag ${p.live ? "live" : "paper"}">${p.live ? "live" : "would-have"}</span></div>
      <div class="r">${p.lastMarkX == null ? "mark unread" : `${Number(p.lastMarkX).toFixed(3)}x`} · ${ago(now - Number(p.openedAt))}</div>
      <div class="m">${state} · ${Number(p.sizeSol).toFixed(4)} SOL</div>
      ${p.live ? `<button class="forget" data-forget="${esc(p.mint)}" title="Close this row without a sale: the realized figure will read 'not read'">forget</button>` : ""}
    </div>`;
  }).join("") : `<div class="empty">nothing open</div>`;
  for (const b of document.querySelectorAll("button[data-forget]")) b.addEventListener("click", async () => {
    if (!confirm(`Forget ${short(b.dataset.forget)}? Only do this after selling it by hand.`)) return;
    await send(UI.FORGET_POSITION, { mint: b.dataset.forget });
  });
  $("chkPause").checked = s.control?.pauseEntries === true;
  $("chkHardStop").checked = s.control?.hardStop === true;

  const book = s.book ?? {};
  $("bookLine").textContent = book.liveTrades ? `${book.liveTrades} live · ${book.liveWins} up · ${book.liveLosses} down${book.unread ? ` · ${book.unread} not read` : ""}` : "no live trades";
  $("realizedLine").textContent = book.liveTrades ? fmtSol(book.realizedSol) : "—";
  const closes = (s.closes ?? []).filter((c) => c.reason !== "superseded by the live fill").slice(0, 6);
  $("closes").innerHTML = closes.map((c) => `<div class="item">
      <div class="t">${esc(c.symbol ?? short(c.mint))} <span class="tag ${c.live ? "live" : "paper"}">${c.live ? "live" : "would-have"}</span></div>
      <div class="r ${c.pnlSol == null ? "" : c.pnlSol >= 0 ? "up" : "down"}">${c.live ? fmtSol(c.pnlSol) : c.markX == null ? "unread" : `${Number(c.markX).toFixed(3)}x`}</div>
      <div class="m">${esc(c.reason)} · held ${ago(c.heldMs ?? 0)}</div>
    </div>`).join("");

  const sh = s.shadow ?? {};
  const card = sh.scorecard ?? {};
  $("shadowLine").textContent = `${sh.rows ?? 0} rows · ${card.judged ?? 0} judged`;
  $("scorecard").innerHTML = card.proxies ? Object.entries(card.proxies).map(([name, p]) => `<div class="ruler ${p.promotable ? "promotable" : ""}">
      <div class="t">${esc(name)}</div>
      <div class="m">${esc(p.rule)}</div>
      <div class="m">n ${p.n} · flagged ${p.flagged} · precision ${p.precision == null ? "—" : p.precision}</div>
      <div class="m">${esc(p.why)}</div>
    </div>`).join("") : "";
  $("refusals").innerHTML = (s.refusals ?? []).slice(0, 5).map((r) => `<div class="item"><div class="t">${esc(r.symbol ?? short(r.mint))}</div><div class="r">${esc(r.gate)}</div><div class="m">${esc(r.message)}</div></div>`).join("") || `<div class="empty">none yet</div>`;

  const R = s.record;
  if (R) {
    $("record").innerHTML = `
      <p>HAWK-AI's first ${R.first58.trades} live round trips, read back off mainnet on ${R.readAt}: <b>${R.first58.won} up, ${R.first58.lost} down, ${R.first58.netSol} SOL</b>. Six more under the socials filter and the stall exit: ${R.after.won} up, ${R.after.lost} down, ${R.after.netSol} SOL. ${R.tenMinuteClock.ran} positions ran to the old ten-minute clock; ${R.tenMinuteClock.won} won.</p>
      <table><tr><th>seconds late</th><th>n</th><th>won</th><th>mean</th></tr>${R.bySecondsLate.map((b) => `<tr><td>${esc(b.bucket)}</td><td class="n">${b.n}</td><td class="n">${b.wonPct}%</td><td class="n">${b.meanPct > 0 ? "+" : ""}${b.meanPct}%</td></tr>`).join("")}</table>
      <table><tr><th>entry size</th><th>n</th><th>won</th><th>net</th></tr>${R.bySize.map((b) => `<tr><td>${esc(b.bucket)}</td><td class="n">${b.n}</td><td class="n">${b.wonPct}%</td><td class="n">${b.netSol > 0 ? "+" : ""}${b.netSol} SOL</td></tr>`).join("")}</table>
      <table><tr><th>reached after the fill</th><th>of 64</th></tr>${R.reached.map((b) => `<tr><td>${b.x}×</td><td class="n">${b.of64}</td></tr>`).join("")}</table>
      <p>Every modelled exit ladder over the 64 still loses (best: ${R.all64.bestModelledLadderSol} SOL against ${R.all64.netSol} actual). Nothing measured at entry orders the outcome. This lane waits ${Math.round((s.entryWaitMs ?? 0) / 1000)}s and buys only a launch that still marks ≥${s.entryFollowThroughX}x — a rule that keeps it out of the bucket that never won, not evidence of an edge. The shadow book grades it; export it and run <code>node vendor/executor/grade-entry-gates.mjs --file</code>.</p>`;
  }
  $("log").innerHTML = (s.log ?? []).slice(0, 10).map((l) => `<div>${Number.isFinite(l.at) ? esc(new Date(l.at).toISOString().slice(11, 19)) : ""} ${esc(l.line)}</div>`).join("");
  $("versionLine").textContent = s.version ?? "";
}

async function refresh() {
  const res = await send(UI.GET_STATUS).catch(() => null);
  if (res?.ok) { status = res.status; render(); }
}

$("btnConsole").addEventListener("click", () => send(UI.OPEN_CONSOLE));
$("btnConnect").addEventListener("click", async () => {
  const res = await send(UI.CONNECT);
  if (!res?.ok) toast(res?.error ?? "connect failed");
  refresh();
});
$("lnkOptions").addEventListener("click", (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
for (const b of document.querySelectorAll("#laneSeg button")) b.addEventListener("click", async () => {
  chosenLane = b.dataset.lane;
  if (chosenLane === "execute") { render(); return; }         // the ceremony below arms it
  const res = await send(UI.ARM, { lane: chosenLane });
  if (!res?.ok) toast(res?.error ?? "could not switch the lane");
  refresh();
});
$("btnCopyAck").addEventListener("click", () => { $("ackInput").value = status?.armability?.expectedAck ?? ""; });
$("btnArm").addEventListener("click", async () => {
  const liveAck = $("ackInput").value.trim();
  const res = await send(UI.ARM, { lane: "execute", liveAck });
  if (!res?.ok) { toast(res?.error ?? "could not arm"); return; }
  status = res.status; chosenLane = "execute";
  if (!status.executing) toast(`Not armed: ${(status.armability?.blocking ?? []).join(", ") || "the sentence does not match"}`);
  render();
});
$("chkPause").addEventListener("change", (e) => send(UI.PAUSE, { on: e.target.checked }));
$("chkHardStop").addEventListener("change", (e) => {
  if (e.target.checked && !confirm("HARD STOP sells every live position at the next readable mark and refuses every entry. Continue?")) { e.target.checked = false; return; }
  send(UI.HARD_STOP, { on: e.target.checked });
});
$("btnExport").addEventListener("click", async () => {
  const res = await send("hawk:ui:export-shadow");
  if (!res?.ok) { toast(res?.error ?? "export failed"); return; }
  const blob = new Blob([res.jsonl], { type: "application/x-ndjson" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `coinmarketcat-shadow-${new Date().toISOString().slice(0, 10)}.jsonl`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
  toast(`${res.rows} rows exported — grade them with node vendor/executor/grade-entry-gates.mjs --file`);
});
chrome.runtime.onMessage.addListener((msg) => { if (msg?.type === UI.STATUS_CHANGED && msg.status) { status = msg.status; render(); } });
refresh();
setInterval(refresh, 3_000);
