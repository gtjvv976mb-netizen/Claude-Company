/**
 * THE FIRST-RUN SETUP PAGE: a new user's own limits, before anything can spend.
 *
 * The worker opens this page once, when the extension is installed. It walks the user
 * through six things — an RPC and Phantom, a style, their own limits, the stock tokens
 * to focus on, who signs, and Observe — and saves them through the same SET_CONFIG the
 * Options page uses, fenced by the same normalizeConfig the engine runs. It never arms:
 * saving puts the lane in Observe. It stores nothing itself (the worker is the only
 * writer), logs nothing, and the only secret it ever touches is a new autopilot
 * wallet's passphrase, sent once to the worker's keystore and cleared from the page.
 */
import { UI, AUTOPILOT } from "../lib/protocol.mjs";
import {
  CONFIG_DEFAULTS, normalizeConfig, STYLE_PRESETS, STOCK_FOCUS_CHOICES, STOCK_CANARY_RULE, CANARY_SOL, RECORD,
} from "../lib/config.mjs";

const $ = (id) => document.getElementById(id);
const send = (type, payload = {}) => chrome.runtime.sendMessage({ type, ...payload });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const LIMIT_INPUTS = ["maxSolPerTrade", "dailySolCap", "takeAtEntryX", "stopFrac", "stallS", "timeStopS"];

let current = CONFIG_DEFAULTS;
let style = "balanced";

/* ── step 2: the styles ─────────────────────────────────────────────────────────────── */
function presetLine(v) {
  return `${v.maxSolPerTrade} SOL a trade · ${v.dailySolCap} SOL a day · take ${v.takeAtEntryX}× · stall ${v.stallMs / 1000} s · time stop ${v.timeStopMs / 1000} s${v.stopFrac === null ? "" : ` · stop ${v.stopFrac}×`}`;
}
function renderPresets() {
  $("presets").innerHTML = Object.values(STYLE_PRESETS).map((p) => `
    <label class="preset ${p.looser ? "looser" : ""} ${style === p.id ? "on" : ""}" data-preset="${p.id}">
      <div class="t"><input type="radio" name="preset" value="${p.id}" ${style === p.id ? "checked" : ""}>${esc(p.label)}${p.looser ? `<span class="tag">looser</span>` : ""}</div>
      <div class="d">${esc(p.summary)}</div>
      <div class="v">${esc(presetLine(p.values))}</div>
    </label>`).join("") + (style === "custom" ? `<p class="note">Custom: your own numbers from step 3.</p>` : "");
  for (const input of document.querySelectorAll('input[name="preset"]')) input.addEventListener("change", () => { style = input.value; fillLimits(STYLE_PRESETS[style].values); renderPresets(); });
}

/* ── step 3: the limits ─────────────────────────────────────────────────────────────── */
function fillLimits(v) {
  $("maxSolPerTrade").value = v.maxSolPerTrade;
  $("dailySolCap").value = v.dailySolCap;
  $("takeAtEntryX").value = v.takeAtEntryX ?? 1.5;
  $("stopFrac").value = v.stopFrac === null || v.stopFrac === undefined ? "" : v.stopFrac;
  $("stallS").value = v.stallMs === null || v.stallMs === undefined ? 90 : Math.round(v.stallMs / 1000);
  $("timeStopS").value = v.timeStopMs === null || v.timeStopMs === undefined ? 180 : Math.round(v.timeStopMs / 1000);
  noteLimits();
}
const numberOf = (id) => { const v = $(id).value.trim(); return v === "" ? null : Number(v); };
function readLimits() {
  const stall = numberOf("stallS"), time = numberOf("timeStopS");
  return {
    maxSolPerTrade: numberOf("maxSolPerTrade"), dailySolCap: numberOf("dailySolCap"), takeAtEntryX: numberOf("takeAtEntryX"),
    stopFrac: numberOf("stopFrac"), stallMs: stall === null ? null : Math.round(stall * 1000), timeStopMs: time === null ? null : Math.round(time * 1000),
  };
}
/** Which preset the numbers on screen are, or "custom". */
function styleOf(limits) {
  for (const p of Object.values(STYLE_PRESETS)) {
    const v = p.values;
    if (["maxSolPerTrade", "dailySolCap", "takeAtEntryX", "stopFrac", "stallMs", "timeStopMs"].every((k) => (v[k] ?? null) === (limits[k] ?? null))) return p.id;
  }
  return "custom";
}
function noteLimits() {
  const l = readLimits();
  const notes = [];
  if (l.maxSolPerTrade > CANARY_SOL && l.stopFrac === null)
    notes.push(`A ${l.maxSolPerTrade} SOL ticket is above the ${CANARY_SOL} SOL canary: choose a stop, or the lane will not arm.`);
  if (l.maxSolPerTrade > RECORD.sizeBucketWarnAboveSol)
    notes.push(`On the record every SOL of net loss sat in tickets of 0.35 SOL and up; ${l.maxSolPerTrade} SOL is above the ${RECORD.sizeBucketWarnAboveSol} SOL line the lane warns at.`);
  if (l.takeAtEntryX !== null && l.takeAtEntryX > 1.5) notes.push(`A ${l.takeAtEntryX}× take is looser than the record's 1.5×.`);
  if (l.stallMs !== null && l.stallMs > 90_000) notes.push(`A ${l.stallMs / 1000} s stall is looser than the record's 90 s.`);
  if (l.timeStopMs !== null && l.timeStopMs > 180_000) notes.push(`A ${l.timeStopMs / 1000} s time stop is looser than the record's 180 s; positions held 120–300 s won 0 of 3.`);
  if (l.dailySolCap !== null && l.maxSolPerTrade !== null && l.dailySolCap < l.maxSolPerTrade) notes.push("The daily budget must be at least one ticket.");
  $("limitsNote").textContent = notes.join(" ");
  $("limitsNote").className = notes.length ? "note warn" : "note";
}

/* ── step 4: the stocks ─────────────────────────────────────────────────────────────── */
function renderStocks(listed) {
  const byMint = new Map((listed ?? []).map((q) => [q.mint, q]));
  /* The known choices first, then any stock listed earlier in Options, so none is dropped. */
  const rows = [...STOCK_FOCUS_CHOICES, ...(listed ?? []).filter((q) => !STOCK_FOCUS_CHOICES.some((k) => k.mint === q.mint))
    .map((q) => ({ mint: q.mint, symbol: q.symbol, name: "listed in Options", sourceNote: "added by you in Options" }))];
  $("stocks").innerHTML = rows.map((k) => {
    const q = byMint.get(k.mint);
    const val = (key) => (q && q[key] !== undefined && q[key] !== null ? q[key] : "");
    return `<div class="stock" data-mint="${esc(k.mint)}" data-symbol="${esc(k.symbol)}">
      <label class="head"><input type="checkbox" data-pick ${q ? "checked" : ""}> <b>${esc(k.symbol)}</b> ${esc(k.name ?? "")} <span class="src">— ${esc(k.sourceNote ?? "")}</span></label>
      <div class="mono">${esc(k.mint)}</div>
      <div class="amounts ${q ? "" : "hidden"}">
        <label class="field"><span>Per launch (${esc(k.symbol)})</span><input type="number" step="any" min="0" data-q="maxPerTrade" value="${esc(val("maxPerTrade"))}" placeholder="e.g. 0.05"></label>
        <label class="field"><span>First buy, the canary (${esc(k.symbol)})</span><input type="number" step="any" min="0" data-q="minPerTrade" value="${esc(val("minPerTrade"))}" placeholder="smaller, e.g. 0.01"></label>
        <label class="field"><span>Per rolling 24 h (${esc(k.symbol)})</span><input type="number" step="any" min="0" data-q="dailyCap" value="${esc(val("dailyCap"))}" placeholder="e.g. 0.5"></label>
      </div>
    </div>`;
  }).join("");
  for (const box of document.querySelectorAll("[data-pick]")) box.addEventListener("change", () => {
    box.closest(".stock").querySelector(".amounts").classList.toggle("hidden", !box.checked);
  });
  $("canaryRule").textContent = `Canary rule: ${STOCK_CANARY_RULE}`;
}
function readStocks() {
  return [...document.querySelectorAll(".stock")].filter((row) => row.querySelector("[data-pick]").checked).map((row) => {
    const q = { mint: row.dataset.mint, symbol: row.dataset.symbol };
    for (const input of row.querySelectorAll("[data-q]")) { const v = input.value.trim(); if (v !== "") q[input.dataset.q] = v; }
    return q;
  });
}

/* ── step 5: the signer ─────────────────────────────────────────────────────────────── */
const signerChoice = () => document.querySelector('input[name="signerMode"]:checked')?.value ?? "phantom";
async function refreshAutopilot() {
  const autopilot = signerChoice() === "autopilot";
  $("autopilotBox").classList.toggle("hidden", !autopilot);
  if (!autopilot) return;
  const res = await send(AUTOPILOT.STATUS).catch(() => null);
  const a = res?.ok ? res.autopilot : null;
  $("autopilotCreate").classList.toggle("hidden", Boolean(a?.exists));
  $("autopilotLine").innerHTML = a?.exists ? `The autopilot wallet exists: <span class="mono">${esc(a.publicKey)}</span> — ${a.unlocked ? "unlocked" : "locked"}.` : "";
}
$("btnCreate").addEventListener("click", async () => {
  const p1 = $("pass1"), p2 = $("pass2");
  const line = $("autopilotLine");
  try {
    if (p1.value.length < 12) { line.textContent = "The passphrase must be at least 12 characters."; line.className = "status bad"; return; }
    if (p1.value !== p2.value) { line.textContent = "The two passphrases differ — type the same one twice."; line.className = "status bad"; return; }
    $("btnCreate").disabled = true;
    line.textContent = "Creating and encrypting the key (this takes a second)…"; line.className = "status";
    const res = await send(AUTOPILOT.CREATE, { passphrase: p1.value, confirm: p2.value });
    if (!res?.ok) { line.textContent = res?.error ?? "could not create the autopilot wallet"; line.className = "status bad"; return; }
    line.className = "status good";
    await refreshAutopilot();
  } finally {
    p1.value = ""; p2.value = "";       // the passphrase does not stay on the page
    $("btnCreate").disabled = false;
  }
});
for (const radio of document.querySelectorAll('input[name="signerMode"]')) radio.addEventListener("change", refreshAutopilot);

/* ── step 1: the console tab and Phantom ────────────────────────────────────────────── */
$("btnConsole").addEventListener("click", () => send(UI.OPEN_CONSOLE));
async function refreshPhantom() {
  const res = await send(UI.GET_STATUS).catch(() => null);
  const s = res?.ok ? res.status : null;
  const wallet = s?.phantomWallet ?? null;
  $("phantomLine").innerHTML = wallet ? `Phantom: connected as <span class="mono">${esc(wallet)}</span>` : s?.bridgeReady ? "Phantom: the console tab is open — press Connect Phantom there" : "Phantom: not connected — open the console page";
  $("phantomLine").className = wallet ? "status good" : "status";
}

/* ── step 6: save, into Observe ─────────────────────────────────────────────────────── */
$("btnSave").addEventListener("click", async () => {
  for (const el of document.querySelectorAll(".bad")) el.classList.remove("bad");
  const limits = readLimits();
  const draft = {
    rpcUrl: $("rpcUrl").value.trim(),
    ...limits,
    entryWaitMs: STYLE_PRESETS.balanced.values.entryWaitMs, entryFollowThroughX: STYLE_PRESETS.balanced.values.entryFollowThroughX,
    quoteMints: readStocks(), signerMode: signerChoice(), stylePreset: styleOf(limits),
    setupCompletedAt: Date.now(), lane: "observe",
  };
  const line = $("saveLine");
  try { normalizeConfig({ ...current, ...draft }); }
  catch (error) {
    line.textContent = error.message; line.className = "status bad";
    const map = { stallMs: "stallS", timeStopMs: "timeStopS" };
    const el = error.key === "quoteMints" ? $("stocks") : $(map[error.key] ?? error.key);
    el?.classList.add("bad"); el?.scrollIntoView?.({ block: "center" });
    return;
  }
  const res = await send(UI.SET_CONFIG, { config: draft });
  if (!res?.ok) { line.textContent = res?.error ?? "save failed"; line.className = "status bad"; return; }
  current = res.config;
  line.textContent = current.rpcUrl ? "Saved. The lane is in Observe." : "Saved, in Observe — but with no RPC URL it cannot watch anything yet: paste one in step 1 and save again.";
  line.className = current.rpcUrl ? "status good" : "status bad";
  $("doneText").textContent = current.signerMode === "autopilot"
    ? `Style ${current.stylePreset}, ${current.maxSolPerTrade} SOL a trade, ${current.dailySolCap} SOL a day, signer: autopilot. Next, in the popup: create the autopilot wallet if you have not, Fund from Phantom (one approval), Unlock — and watch the book in Observe before you arm.`
    : `Style ${current.stylePreset}, ${current.maxSolPerTrade} SOL a trade, ${current.dailySolCap} SOL a day, signer: Phantom, one approval per trade. Keep the console tab open, and watch the book in Observe before you arm.`;
  $("step-done").classList.remove("hidden");
  $("step-done").scrollIntoView({ behavior: "smooth" });
});

for (const id of LIMIT_INPUTS) $(id).addEventListener("input", () => { style = styleOf(readLimits()); renderPresets(); noteLimits(); });

/* ── load: a re-run starts from what is saved ───────────────────────────────────────── */
async function load() {
  const res = await send(UI.GET_CONFIG).catch(() => null);
  current = res?.ok ? res.config : CONFIG_DEFAULTS;
  $("rpcUrl").value = current.rpcUrl ?? "";
  style = current.stylePreset && current.stylePreset !== "" ? current.stylePreset : "balanced";
  if (STYLE_PRESETS[style] && !current.setupCompletedAt) fillLimits(STYLE_PRESETS[style].values);
  else fillLimits({ ...current, stallMs: current.stallMs ?? STYLE_PRESETS.balanced.values.stallMs, timeStopMs: current.timeStopMs ?? STYLE_PRESETS.balanced.values.timeStopMs });
  style = styleOf(readLimits());
  renderPresets();
  renderStocks(current.quoteMints ?? []);
  const radio = document.querySelector(`input[name="signerMode"][value="${current.signerMode === "autopilot" ? "autopilot" : "phantom"}"]`);
  if (radio) radio.checked = true;
  await refreshAutopilot();
  await refreshPhantom();
  $("riskLine").textContent = `The record this lane is built on loses: HAWK-AI's first ${RECORD.first58.trades} live round trips were ${RECORD.first58.won} up and ${RECORD.first58.lost} down, ${RECORD.first58.netSol} SOL, and every modelled variant of it still loses (the best, ${RECORD.all64.bestModelledLadderSol} SOL over ${RECORD.all64.trades}). Nothing here is evidence of an edge, nothing here is advice, and either signer can lose everything you let it spend. Observe first.`;
}
load();
setInterval(refreshPhantom, 3_000);
