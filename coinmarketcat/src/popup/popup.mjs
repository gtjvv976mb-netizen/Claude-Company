/**
 * THE POPUP: A WINDOW ONTO THE ENGINE'S STATUS, AND THE SWITCH.
 *
 * Everything shown is `engine.status()` as the service worker hands it over; nothing is
 * computed here that the lane does not already know. The one thing this page does that
 * matters is the arming ceremony: the lane prints the sentence for the connected wallet,
 * the user puts it in the box, and the worker compares the two byte for byte.
 *
 * The Autopilot card drives the autopilot wallet through the worker's AUTOPILOT messages:
 * create, unlock, lock, fund from Phantom, sweep back, and the recovery export. The page
 * builds no transaction and holds no key. A passphrase typed here goes to the worker once
 * and is cleared from its field; the exported key is shown once, in one box, and cleared
 * when hidden, when its section closes, after two minutes, or when the popup closes.
 * Nothing here is stored or logged.
 */
import { UI, AUTOPILOT } from "../lib/protocol.mjs";

const $ = (id) => document.getElementById(id);
const send = (type, payload = {}) => chrome.runtime.sendMessage({ type, ...payload });
const short = (k) => (typeof k === "string" && k.length > 12 ? `${k.slice(0, 4)}…${k.slice(-4)}` : String(k ?? "—"));
const fmtSol = (n, d = 4) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? "not read" : `${Number(n) >= 0 ? "+" : ""}${Number(n).toFixed(d)} SOL`);
/** An amount in the unit it was paid in: SOL to four places, a stock to up to eight
 *  (its raw amount over 10^decimals — Phantom shows SPYx scaled by its multiplier). */
const amt = (n, symbol = "SOL") => {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "not read";
  const x = Number(n);
  return symbol === "SOL" ? `${x.toFixed(4)} SOL` : `${Number(x.toFixed(8))} ${symbol}`;
};
const signed = (n, symbol = "SOL") => (n === null || n === undefined || !Number.isFinite(Number(n)) ? "not read" : `${Number(n) >= 0 ? "+" : ""}${amt(n, symbol)}`);
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

  const phantom = s.phantomWallet !== undefined ? s.phantomWallet : s.wallet;
  $("walletLine").textContent = phantom ? phantom : s.bridgeReady ? "console open — not connected" : "open the console page first";
  $("btnConnect").disabled = !s.bridgeReady;
  $("setupCard").classList.toggle("hidden", Boolean(s.setupCompletedAt) || s.booting === true);
  renderSigner(s);
  $("feedLine").textContent = `${s.feed?.state ?? "stopped"}${s.feed?.counters?.notifications ? ` · ${s.feed.counters.notifications} logs` : ""}`;
  $("rpcLine").textContent = s.rpc ? (() => { try { return new URL(s.rpc).host; } catch { return "set"; } })() : "not set";

  if (chosenLane === null) chosenLane = s.lane;
  for (const b of document.querySelectorAll("#laneSeg button")) b.classList.toggle("on", b.dataset.lane === chosenLane);
  const arm = s.armability;
  const showArm = chosenLane === "execute" && !s.executing;
  $("armBox").classList.toggle("hidden", !showArm);
  const auto = s.signerMode === "autopilot";
  if (arm) {
    $("checklist").innerHTML = arm.items.map((i) => `<li class="${i.ok ? "ok" : ""}"><b>${esc(i.name.replace(/_/g, " "))}</b> — ${esc(i.detail)}</li>`).join("");
    $("expectedAck").textContent = arm.expectedAck ?? (auto ? "create the autopilot wallet to see the sentence" : "connect Phantom on the console page to see the sentence");
    $("btnArm").disabled = !arm.expectedAck;
    $("btnArm").textContent = auto ? "Arm — the autopilot wallet will sign without asking" : "Arm — Phantom will be asked to sign";
    $("warnings").innerHTML = (arm.warnings ?? []).map((w) => `<li>${esc(w.detail)}</li>`).join("");
  }
  $("laneHint").textContent = s.executing
    ? `Armed${auto ? " on autopilot" : ""}. ${s.entryInFlight ? (auto ? `The autopilot wallet is signing a buy of ${short(s.entryInFlight)}.` : `A Phantom window is open for ${short(s.entryInFlight)}.`) : "Waiting for a launch that clears the gates and holds up for the wait."}`
    : chosenLane === "observe" ? "Observe: every launch is evaluated and a would-have position is sampled forward. Nothing is signed."
      : chosenLane === "execute" ? (auto
        ? "Execute on autopilot: once the checklist is green and the sentence matches, each cleared launch that still marks above its would-have fill after the wait is bought — signed by the autopilot wallet, without asking you — and sold the same way."
        : "Execute: once the checklist is green and the sentence matches, each cleared launch that still marks above its would-have fill after the wait becomes one Phantom window.")
        : "Off constructs nothing.";

  $("dayLine").textContent = `${Number(s.deployedTodaySol ?? 0).toFixed(4)} / ${s.dailySolCap} SOL`;
  $("ticketLine").textContent = `${s.maxSolPerTrade} SOL`;

  /* THE STOCKS, each in its own units, with the canary rule said out loud. */
  const stocks = s.quoteMints ?? [];
  $("stockBox").classList.toggle("hidden", stocks.length === 0);
  $("stocks").innerHTML = stocks.map((q) => {
    const state = q.canary === "proven" ? "proven" : q.canary === "blocked" ? "blocked" : "canary";
    const next = state === "blocked" ? "no live buys until you clear the block"
      : state === "proven" ? `next live buy up to ${amt(q.maxPerTrade, q.symbol)} (a ${q.symbol} buy was read back${q.canarySignature ? ` — ${short(q.canarySignature)}` : ""})`
        : `next live buy is the canary: ${amt(q.minPerTrade, q.symbol)}, then up to ${amt(q.maxPerTrade, q.symbol)}`;
    const scaled = Number.isFinite(q.scaledUiMultiplier) && q.scaledUiMultiplier !== 1
      ? ` · Phantom shows ${esc(q.symbol)} scaled ×${Number(q.scaledUiMultiplier).toFixed(6)}; amounts here are the raw count` : "";
    return `<div class="item">
      <div class="t">${esc(q.symbol)} <span class="tag ${state}">${state}</span>${q.paused === true ? ` <span class="tag paused">paused by its issuer</span>` : ""}</div>
      <div class="r">${q.deployedToday === null ? "not read" : amt(q.deployedToday, q.symbol)} / ${amt(q.dailyCap, q.symbol)}</div>
      <div class="m">${esc(next)}${state === "blocked" && q.canaryDetail ? ` — ${esc(q.canaryDetail)}` : ""}${scaled}</div>
      <div class="m mono">${esc(q.mint)}</div>
      ${state === "blocked" ? `<button class="clear" data-clear="${esc(q.mint)}" title="Only after you have checked that buy's signature and sold it by hand">clear the block</button>` : ""}
    </div>`;
  }).join("");
  $("canaryRule").textContent = stocks.length ? `Canary rule: ${s.stockCanaryRule ?? ""} Nothing about stock-quoted launches has been measured: no win rate, no fee on a buy.` : "";
  for (const b of document.querySelectorAll("button[data-clear]")) b.addEventListener("click", async () => {
    if (!confirm("Clear the block? Do this only after you checked that buy's signature on an explorer and sold the position by hand. The next buy in this stock will be a canary again.")) return;
    await send(UI.CLEAR_STOCK_CANARY, { mint: b.dataset.clear });
    refresh();
  });
  $("waitLine").textContent = `${Math.round((s.entryWaitMs ?? 0) / 1000)}s · ≥${s.entryFollowThroughX}x`;
  renderXstock(s, now);

  const open = s.open ?? [];
  $("positions").innerHTML = open.length ? open.map((p) => {
    const cls = p.live ? "live" : "";
    const pend = p.pendingSell ? "pending" : "";
    const onAuto = p.live && s.autopilot?.publicKey && p.wallet === s.autopilot.publicKey;
    const state = p.graduated ? (onAuto ? "graduated — Forget, Sweep back, SELL BY HAND in Phantom" : "graduated — SELL BY HAND")
      : p.pendingSell ? (onAuto ? (s.autopilot.unlocked ? `selling (autopilot) — ${esc(p.pendingSell.reason)}` : `UNLOCK THE AUTOPILOT WALLET TO SELL — ${esc(p.pendingSell.reason)}`) : `APPROVE THE SELL IN PHANTOM — ${esc(p.pendingSell.reason)}`)
        : p.waitedOut ? `not bought: ${esc(p.waitedOut)}` : p.live ? (onAuto ? "held by the autopilot wallet" : "held") : p.liveAttempted ? "watched (attempted)" : "watching";
    const venueTag = p.venue === "jupiter-xstock" ? ` <span class="tag venue" title="${esc(p.pool ?? "")}">Jupiter · ${esc(p.dex ?? "pool")}</span>` : "";
    return `<div class="item ${cls} ${pend}" data-mint="${esc(p.mint)}">
      <div class="t">${esc(p.symbol ?? short(p.mint))} <span class="tag ${p.live ? "live" : "paper"}">${p.live ? "live" : "would-have"}</span>${venueTag}</div>
      <div class="r">${p.lastMarkX == null ? "mark unread" : `${Number(p.lastMarkX).toFixed(3)}x`} · ${ago(now - Number(p.openedAt))}</div>
      <div class="m">${state} · ${amt(p.sizeSol, p.quoteSymbol ?? "SOL")}${p.quoteSymbol ? " (fees in SOL)" : ""}${p.quotePaused === true ? ` · ${esc(p.quoteSymbol)} PAUSED — cannot sell` : ""}</div>
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
  $("realizedQuoteLine").textContent = Object.values(book.realizedByQuote ?? {}).map((r) => `${signed(r.ui, r.symbol)} over ${r.trades} · fees ${Number(r.feeSol).toFixed(4)} SOL`).join(" · ");
  const closes = (s.closes ?? []).filter((c) => c.reason !== "superseded by the live fill").slice(0, 6);
  $("closes").innerHTML = closes.map((c) => `<div class="item">
      <div class="t">${esc(c.symbol ?? short(c.mint))} <span class="tag ${c.live ? "live" : "paper"}">${c.live ? "live" : "would-have"}</span></div>
      ${(() => { const pnl = c.quoteSymbol ? c.pnlQuote : c.pnlSol; return `<div class="r ${pnl == null ? "" : pnl >= 0 ? "up" : "down"}">${c.live ? (c.quoteSymbol ? signed(pnl, c.quoteSymbol) : fmtSol(pnl)) : c.markX == null ? "unread" : `${Number(c.markX).toFixed(3)}x`}</div>`; })()}
      <div class="m">${esc(c.reason)} · held ${ago(c.heldMs ?? 0)}${c.quoteSymbol && c.live && c.feeSolPaid != null ? ` · network fees ${Number(c.feeSolPaid).toFixed(4)} SOL beside it` : ""}${c.canary ? " · the canary" : ""}</div>
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
  const byQuote = Object.entries(sh.scorecardByQuote ?? {}).filter(([q]) => q !== "So11111111111111111111111111111111111111112");
  const symbolOf = (mint) => (s.quoteMints ?? []).find((q) => q.mint === mint)?.symbol ?? short(mint);
  $("quoteCards").innerHTML = byQuote.map(([q, c]) => `<div class="item"><div class="t">${esc(symbolOf(q))}-quoted launches</div><div class="r">${c.judged ?? 0} judged</div><div class="m">graded apart from SOL launches, on their own card; export and run the grader with --quote ${esc(q)}</div></div>`).join("");
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

/* ── the venue card: the xStock venue ───────────────────────────────────────────────── */
const STATE_WORDS = { new: "new", pending: "waiting for Jupiter", refused: "refused", refused_live: "refused at the attempt", watching: "watching", unsampled: "cleared, not marked", waited_out: "nobody followed", entered: "bought", sold: "sold", closed: "closed" };
function renderXstock(s, now) {
  const x = s.xstock ?? null;
  const on = x?.enabled === true;
  $("chkXstock").checked = on;
  $("xstockPill").textContent = !on ? "off" : s.lane === "off" ? "on · lane off" : s.executing ? "on · live" : s.lane === "execute" ? "on · not armed" : "on · observe";
  $("xstockPill").className = `pill ${on ? (s.executing ? "execute" : "observe") : ""}`;
  $("xstockBody").classList.toggle("hidden", !on);
  if (!x) return;
  $("xstockHint").textContent = on
    ? `On. It polls ${x.sources.join(" and ")} every ${Math.round((x.pollMs ?? 0) / 1000)}s (next in ${Math.round((x.nextPollInMs ?? 0) / 1000)}s) and judges each pool it finds; ${s.lane === "execute" ? (s.executing ? "armed, a pool that still marks at or above its would-have fill after the wait is bought through Jupiter, paid in its stock" : "not armed, so nothing is bought") : s.lane === "observe" ? "Observe keeps would-have positions and signs nothing" : "the lane is Off, so nothing is polled"}.`
    : "Off. When on, it polls public new-pool feeds for pools anywhere on Solana that pair a token with a stock you watch, and follows the lane: Observe keeps would-have positions, Execute (armed) trades them through Jupiter, paid in that stock, inside that stock's limits.";
  const feeds = x.discovery?.feeds ?? [];
  $("xstockFeeds").textContent = feeds.length ? feeds.map((f) => `${f.id}: ${f.ok} ok${f.rateLimited ? ` · ${f.rateLimited}×429` : ""}${f.errors ? ` · ${f.errors} errors` : ""}${f.resting ? ` · resting ${ago(f.backoffUntil - now)}` : ""}`).join(" | ") : "not polled yet";
  const listed = (x.focus ?? []).filter((f) => f.listed);
  $("xstockFocus").textContent = listed.length ? listed.map((f) => f.symbol).join(", ")
    : `the built-in list (${(x.focus ?? []).map((f) => f.symbol).join(", ")}) — watch only: list a stock in Options to give it a ticket`;
  const j = x.jupiter ?? {};
  $("xstockJupiter").textContent = `${j.requests ?? 0} requests · ${j.noRoute ?? 0} no route · ${j.skipped ?? 0} marks skipped for the 0.5/s budget${j.restingForMs ? ` · resting ${ago(j.restingForMs)}` : ""}`;
  const blocked = Object.entries(x.canary ?? {}).filter(([, c]) => c.state === "blocked");
  $("xstockBlocks").innerHTML = blocked.map(([mint, c]) => {
    const sym = (s.quoteMints ?? []).find((q) => q.mint === mint)?.symbol ?? short(mint);
    return `<div class="item"><div class="t">${esc(sym)} <span class="tag blocked">blocked in this venue</span></div><div class="m">${esc(c.detail ?? "")} — ${esc(c.signature ?? "")}</div>
      <button class="clear" data-clear-x="${esc(mint)}" title="Only after you have checked that buy's signature and sold it by hand">clear the block</button></div>`;
  }).join("");
  for (const b of document.querySelectorAll("button[data-clear-x]")) b.addEventListener("click", async () => {
    if (!confirm("Clear the block? Do this only after you checked that buy's signature on an explorer and sold the position by hand. The next buy in this stock through Jupiter will be a canary again.")) return;
    await send(UI.CLEAR_STOCK_CANARY, { mint: b.dataset.clearX, venue: "jupiter-xstock" });
    refresh();
  });
  const cands = x.candidates ?? [];
  $("xstockCandidates").innerHTML = cands.length ? cands.slice(0, 12).map((c) => {
    const pair = `${esc(c.tokenSymbol ?? short(c.tokenMint))} / ${esc(c.stockSymbol)}`;
    const age = c.ageAtFirstSightMs == null ? "creation time not given" : `seen ${ago(c.ageAtFirstSightMs)} after it was created`;
    const state = STATE_WORDS[c.state] ?? c.state;
    return `<div class="item"><div class="t">${pair} <span class="tag ${esc(c.state)}">${esc(state)}</span></div>
      <div class="r">${c.gate ? esc(c.gate) : ""}</div>
      <div class="m">${esc(c.dex ?? "?")} · from ${esc((c.sources ?? []).join(" + "))} · ${esc(age)} · found ${ago(now - Number(c.firstSeenAt))} ago</div>
      ${c.message ? `<div class="m">${esc(c.message)}</div>` : ""}
      <div class="m mono">${esc(c.pool)}</div></div>`;
  }).join("") : `<div class="empty">${on ? "none yet — new pools paired with a watched stock are rare" : "the venue is off"}</div>`;
  $("xstockRule").textContent = x.canaryRule ?? "";
  $("xstockUnmeasured").textContent = x.unmeasured ?? "";
}
$("chkXstock").addEventListener("change", async (e) => {
  const on = e.target.checked;
  if (on && !confirm("Turn on the xStock venue?\n\nIt polls public new-pool feeds (GeckoTerminal, DexScreener) for pools that pair a token with a stock you watch. In Observe it only keeps would-have positions. Armed, it buys and sells them through Jupiter, paid in that stock, at that stock's ticket and day cap.\n\nThe arm sentence changes, so an armed lane stops being armed until you type the new sentence. Nothing about these pools has been measured.")) { e.target.checked = false; return; }
  const res = await send(UI.SET_CONFIG, { config: { xstockVenue: on } });
  if (!res?.ok) { toast(res?.error ?? "could not change the venue"); e.target.checked = !on; }
  refresh();
});

/* ── the autopilot card ─────────────────────────────────────────────────────────────── */
let ap = null;               // the worker's AUTOPILOT.STATUS answer: balances, tokens, fund assets, where a sweep goes
let secretTimer = null;
const until = (ms) => (Number.isFinite(ms) ? new Date(ms).toTimeString().slice(0, 5) : "—");
function renderSigner(s) {
  const auto = s.signerMode === "autopilot";
  for (const b of document.querySelectorAll("#signerSeg button")) b.classList.toggle("on", b.dataset.signer === (auto ? "autopilot" : "phantom"));
  const a = s.autopilot ?? null;
  $("signerHint").textContent = auto
    ? `Autopilot: buys and sells are signed by the autopilot wallet without a window${a?.unlocked ? `, while it is unlocked (until ${until(a.expiresAt)})` : " — it is locked now and signs nothing"}. The console tab is needed only to fund from Phantom.`
    : "Phantom: every buy and every sell is one approval window on the console tab. The extension holds no key.";
  const exists = Boolean(a?.publicKey) || Boolean(ap?.exists);
  $("apNone").classList.toggle("hidden", exists);
  $("apSome").classList.toggle("hidden", !exists);
  if (!exists) return;
  const unlocked = a ? a.unlocked === true : ap?.unlocked === true;
  $("apAddress").textContent = a?.publicKey ?? ap?.publicKey ?? "—";
  $("apLockPill").textContent = unlocked ? `unlocked · ${until(a?.expiresAt ?? ap?.expiresAt)}` : "locked";
  $("apLockPill").className = `pill ${unlocked ? "unlocked" : ""}`;
  $("apUnlockRow").classList.toggle("hidden", unlocked);
  $("btnApLock").classList.toggle("hidden", !unlocked);
  const bal = ap?.balanceSol ?? a?.balanceSol ?? null;
  $("apBalance").textContent = bal === null || bal === undefined ? (ap?.readError ? "not read" : "—") : `${Number(bal).toFixed(6)} SOL`;
  $("apTokens").textContent = (ap?.tokens ?? []).map((t) => `${t.ui} ${t.symbol}`).join(" · ");
  $("btnApFund").disabled = !(s.bridgeReady && (s.phantomWallet ?? null));
  $("apFundHint").textContent = s.phantomWallet
    ? `From Phantom ${short(s.phantomWallet)}: one approval on the console tab. The default is your daily budget; the day cap binds either way, and the balance binds too.`
    : "Open the console page and connect Phantom to fund: funding is one Phantom approval, asked on that tab.";
  $("btnApSweep").disabled = !unlocked || !(ap?.sweepTo);
  $("apSweepHint").textContent = !ap?.sweepTo ? "Connect Phantom once so the sweep has a destination."
    : !unlocked ? "Unlock to sweep: the sweep is signed by the autopilot wallet."
      : (s.autopilotHeld ?? 0) > 0 ? `It holds ${s.autopilotHeld} live position${s.autopilotHeld === 1 ? "" : "s"}: a sweep waits until ${s.autopilotHeld === 1 ? "it is" : "they are"} sold.`
        : `Every token, then all SOL above the ${((ap?.rentFloorLamports ?? 890880) / 1e9).toFixed(8)} SOL rent floor, to ${short(ap.sweepTo)}. Phantom is not asked.`;
}
function fillFundForm() {
  if (!ap) return;
  const sel = $("apFundAsset");
  const chosen = sel.value;
  sel.innerHTML = (ap.fundAssets ?? []).map((f) => `<option value="${esc(f.asset)}">${esc(f.symbol)}</option>`).join("");
  if (chosen && [...sel.options].some((o) => o.value === chosen)) sel.value = chosen;
  const asset = (ap.fundAssets ?? []).find((f) => f.asset === sel.value);
  if (asset && !$("apFundAmount").dataset.touched) $("apFundAmount").value = asset.defaultAmount;
  const mins = $("apMinutes");
  if (!mins.options.length) {
    const range = ap.unlockMinutesRange ?? { min: 5, max: 1440 };
    const choices = [...new Set([15, 60, 240, 480, 720, 1440, ap.unlockMinutes])].filter((m) => m >= range.min && m <= range.max).sort((x, y) => x - y);
    mins.innerHTML = choices.map((m) => `<option value="${m}" ${m === ap.unlockMinutes ? "selected" : ""}>${m < 60 ? `${m} min` : `${m / 60} h`}</option>`).join("");
  }
}
async function refreshAutopilot() {
  const res = await send(AUTOPILOT.STATUS).catch(() => null);
  if (res?.ok) { ap = res.autopilot; fillFundForm(); if (status) renderSigner(status); }
}
function clearSecret() {
  $("apSecret").textContent = "";
  $("apSecretBox").classList.add("hidden");
  if (secretTimer) { clearTimeout(secretTimer); secretTimer = null; }
}
async function autopilotCall(type, payload, button) {
  if (button) button.disabled = true;
  try {
    const res = await send(type, payload).catch((error) => ({ ok: false, error: String(error?.message ?? error) }));
    if (!res?.ok) toast(res?.error ?? "the autopilot wallet refused");
    return res;
  } finally {
    if (button) button.disabled = false;
    await refreshAutopilot();
    refresh();
  }
}
for (const b of document.querySelectorAll("#signerSeg button")) b.addEventListener("click", async () => {
  const next = b.dataset.signer;
  if (next === status?.signerMode) return;
  if (next === "autopilot" && !confirm("Switch to autopilot? Once armed, the autopilot wallet signs every buy and sell WITHOUT asking you. The arm sentence changes, so you will type it again.")) return;
  const res = await send(UI.SET_CONFIG, { config: { signerMode: next } });
  if (!res?.ok) toast(res?.error ?? "could not change the signer");
  await refreshAutopilot();
  refresh();
});
$("btnApCreate").addEventListener("click", async () => {
  const p1 = $("apPass1"), p2 = $("apPass2");
  const passphrase = p1.value, confirmText = p2.value;
  p1.value = ""; p2.value = "";
  if (passphrase.length < 12) { toast("The passphrase must be at least 12 characters."); return; }
  if (passphrase !== confirmText) { toast("The two passphrases differ — type the same one twice."); return; }
  toast("Creating and encrypting the key…");
  const res = await autopilotCall(AUTOPILOT.CREATE, { passphrase, confirm: confirmText }, $("btnApCreate"));
  if (res?.ok) toast("Created. It is locked and empty: fund it from Phantom, then unlock it.");
});
$("btnApUnlock").addEventListener("click", async () => {
  const input = $("apPassUnlock");
  const passphrase = input.value;
  input.value = "";
  const res = await autopilotCall(AUTOPILOT.UNLOCK, { passphrase, minutes: Number($("apMinutes").value) }, $("btnApUnlock"));
  if (res?.ok) toast(`Unlocked until ${until(res.expiresAt)}. Lock clears it sooner.`);
});
$("btnApLock").addEventListener("click", async () => {
  const held = status?.autopilotHeld ?? 0;
  if (held && !confirm(`The autopilot wallet holds ${held} live position${held === 1 ? "" : "s"}. Locked, it cannot sell ${held === 1 ? "it" : "them"} until you unlock it again. Lock anyway?`)) return;
  const res = await autopilotCall(AUTOPILOT.LOCK, {}, $("btnApLock"));
  if (res?.ok) toast("Locked: the unlocked key is cleared. It signs nothing until unlocked.");
});
$("apFundAmount").addEventListener("input", () => { $("apFundAmount").dataset.touched = "1"; });
$("apFundAsset").addEventListener("change", () => { delete $("apFundAmount").dataset.touched; fillFundForm(); });
$("btnApFund").addEventListener("click", async () => {
  const asset = $("apFundAsset").value || "SOL";
  const amount = $("apFundAmount").value.trim();
  const f = (ap?.fundAssets ?? []).find((x) => x.asset === asset);
  if (asset === "SOL" && Number(amount) > Number(status?.dailySolCap ?? Infinity)
    && !confirm(`${amount} SOL is more than your ${status.dailySolCap} SOL daily budget. The day cap still binds every trade, but the balance would no longer be the tighter limit. Fund anyway?`)) return;
  toast(`Approve the transfer of ${amount} ${f?.symbol ?? asset} in Phantom, on the console tab.`);
  const res = await autopilotCall(AUTOPILOT.FUND, { asset, amount }, $("btnApFund"));
  if (res?.ok) { delete $("apFundAmount").dataset.touched; toast(`Funded — ${res.summary}.`); }
});
$("btnApSweep").addEventListener("click", async () => {
  const to = ap?.sweepTo;
  if (!to) return;
  if (!confirm(`Sweep the autopilot wallet back to ${to}?\n\nEvery token first, then all SOL above the rent floor. Signed by the autopilot wallet; Phantom is not asked.`)) return;
  toast("Sweeping…");
  const res = await autopilotCall(AUTOPILOT.SWEEP, { expectTo: to }, $("btnApSweep"));
  if (res?.ok) {
    const parts = [res.sol ? `${res.sol.sol} SOL` : res.solNote, ...res.tokens.map((t) => `${t.ui} ${t.symbol}`)].filter(Boolean);
    toast(`Swept to ${short(res.to)}: ${parts.join(", ")}${res.closed ? `; ${res.closed} empty account${res.closed === 1 ? "" : "s"} closed` : ""}${res.skipped.length ? `; not moved: ${res.skipped.map((x) => `${x.symbol ?? "accounts"} (${x.why})`).join("; ")}` : ""}.`);
  }
});
$("btnApExport").addEventListener("click", async () => {
  const input = $("apPassExport");
  const passphrase = input.value;
  input.value = "";
  if (!confirm("Show the autopilot wallet's private key? Anyone who sees it can spend everything in the wallet. Make sure nobody is watching your screen.")) return;
  const res = await send(AUTOPILOT.EXPORT_SECRET, { passphrase }).catch(() => null);
  if (!res?.ok) { toast(res?.error ?? "export refused"); return; }
  $("apSecret").textContent = res.secretBase58;
  $("apSecretBox").classList.remove("hidden");
  if (secretTimer) clearTimeout(secretTimer);
  secretTimer = setTimeout(clearSecret, 120_000);
});
$("btnApReplace").addEventListener("click", async () => {
  const cur = $("apPassCurrent"), n1 = $("apPassNew1"), n2 = $("apPassNew2");
  const currentPassphrase = cur.value, passphrase = n1.value, confirmText = n2.value;
  cur.value = ""; n1.value = ""; n2.value = "";
  if (passphrase.length < 12) { toast("The new passphrase must be at least 12 characters."); return; }
  if (passphrase !== confirmText) { toast("The two new passphrases differ — type the same one twice."); return; }
  if (!confirm("Replace the autopilot wallet? Its key is discarded for good. Only an empty, swept wallet can be replaced.")) return;
  const res = await autopilotCall(AUTOPILOT.CREATE, { passphrase, confirm: confirmText, replace: true, currentPassphrase }, $("btnApReplace"));
  if (res?.ok) { $("apReplaceBox").open = false; toast(`Replaced: the new autopilot wallet is ${short(res.publicKey)}, locked and empty.`); }
});
$("btnApSecretHide").addEventListener("click", clearSecret);
$("apExportBox").addEventListener("toggle", () => { if (!$("apExportBox").open) clearSecret(); });

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
const openSetup = (e) => { e?.preventDefault?.(); chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") }); };
$("lnkSetup").addEventListener("click", openSetup);
$("btnSetup").addEventListener("click", openSetup);
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
refreshAutopilot();
setInterval(refresh, 3_000);
setInterval(refreshAutopilot, 15_000);    // the balance and tokens are live chain reads: not every 3 s
