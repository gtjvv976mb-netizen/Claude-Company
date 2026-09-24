/** THE OPTIONS PAGE: every config key, described, validated by the same normalizeConfig the engine runs. */
import { UI } from "../lib/protocol.mjs";
import {
  CONFIG_DEFAULTS, CONSOLE_URLS, normalizeConfig, RECORD, STOCK_FOCUS_CHOICES, STOCK_CANARY_RULE, MAX_QUOTE_MINTS,
  AUTOPILOT_UNLOCK_MINUTES, STYLE_PRESETS, XSTOCK_SOURCES, XSTOCK_UNMEASURED,
} from "../lib/config.mjs";

const FIELDS = [
  ["Connection", [
    ["rpcUrl", "text", "RPC (https)", "Helius, Triton or QuickNode. The public mainnet RPC refuses browsers. Reads, simulations and sends all go here."],
    ["rpcWsUrl", "text", "RPC websocket (wss)", "Blank derives it from the https URL. The feed is one logsSubscribe on the pump.fun program."],
    ["secondaryRpcUrl", "text", "Second RPC (optional)", "When set, both providers must agree on the curve before a mark is trusted, as WALL-ST-E requires."],
    ["consoleUrl", "select", "Console page", "The page Phantom lives on; the extension is built for these pages only. Keep that tab open."],
  ]],
  ["Who signs", [
    ["signerMode", "select", "Signer", "<b>Phantom</b>: every buy and sell is one Phantom approval window on the console tab, and the extension holds no key. <b>Autopilot</b>: the autopilot wallet (created, funded, unlocked and swept in the popup) signs each trade without a window. A key in a browser is a bigger attack surface than Phantom; your exposure is what you fund it with. Changing this changes the arm sentence.",
      [["phantom", "Phantom — one approval per trade"], ["autopilot", "Autopilot — the autopilot wallet signs"]]],
    ["autopilotUnlockMinutes", "number", "Autopilot unlock lasts (minutes)", `How long an unlock keeps the autopilot wallet's key in memory-only session storage, ${AUTOPILOT_UNLOCK_MINUTES.min} to ${AUTOPILOT_UNLOCK_MINUTES.max}. When it runs out the wallet locks itself and signs nothing — including sells — until you unlock it again. Closing the browser locks it too.`],
  ]],
  ["Size and caps", [
    ["maxSolPerTrade", "number", "SOL per launch", `Operator maximum 1 SOL. The record: every SOL of net loss sat in tickets of 0.35 SOL and up.`],
    ["dailySolCap", "number", "SOL per rolling 24h", "Charged on every live fill and on the fee of every failed entry. Cannot be turned off on an armed lane."],
    ["maxOpenPositions", "number", "Live positions at once", "One Phantom window at a time is the whole point of this lane."],
  ]],
  ["Entry", [
    ["entryWaitMs", "number", "Wait before buying (ms)", `<span class="rec">Record.</span> Entries under 3s won 0 of 9 and averaged −18.5%; entries past 10s won 4 of 10. The lane evaluates at first notice and asks Phantom only after this wait.`],
    ["entryFollowThroughX", "number", "Follow-through (× would-have fill)", `<span class="rec">Record.</span> After the wait the would-have fill must still mark at least this. 0 turns the check off. The shadow book's positive class is a launch nobody followed.`],
    ["requireSocials", "checkbox", "Require a social", "Refuses a launch whose metadata names no twitter, telegram or website. Fails closed. The record: it did not move the win rate (17% → 17%)."],
    ["noticeMaxMs", "number", "Notice staleness bound (ms)", "A notice older than this at first read is refused."],
    ["maxPriceImpactPct", "number", "Max price impact %", "The ceiling ladder halves the ticket until the curve's own quote is inside this."],
    ["maxEntryRoundTripLossPct", "number", "Max immediate round-trip loss %", "What buying and selling straight back would cost on the curve's own arithmetic."],
    ["maxCreatorSharePct", "number", "creator_profile kill (% of supply)", "Blank measures and never kills. Set it only after the scorecard says the ruler is promotable (precision ≥ 0.8 over ≥ 200 rows)."],
    ["maxLaunchSharePct", "number", "launch_share kill (% of opening quote)", "Blank measures and never kills. Same rule."],
  ]],
  ["Exits (blank = snipe-policy's own default)", [
    ["takeAtEntryX", "number", "Take at × entry", `<span class="rec">Record.</span> 44% of the 64 reached 1.5×, 25% reached 2×. A 1.5× take was worth about +${RECORD.takeAt15xWorthSol} SOL over the 64 at a 0.1 SOL ticket. The policy's own default is 2×.`],
    ["stopFrac", "number", "Stop (fraction of entry)", "The whole position leaves at or under this. The 0.20 default was derived for the 0.005 SOL canary; a bigger ticket must choose one."],
    ["stallMs", "number", "Stall (ms)", "A launch that has not cleared stall × entry by here leaves. 0 turns it off. Default 90000: 18 positions ran to the old ten-minute clock, none won."],
    ["stallAtX", "number", "Stall at × entry", "Default 1.0."],
    ["timeStopMs", "number", "Time stop (ms)", "Default 180000."],
    ["holdMaxMs", "number", "Hold clock (ms)", "The backstop for a live position whatever the policy says."],
    ["creatorExitFrac", "number", "Creator exit fraction", "A fall of the deployer's balance by this fraction sells the whole position."],
  ]],
  ["Transaction", [
    ["computeUnitLimit", "number", "Compute unit limit", "A pump.fun buy plus an ATA create runs ~135k units."],
    ["priorityFeeLamports", "number", "Priority fee (lamports)", "Spread over the unit limit as a compute price. The same lamport budget the fee gate judges."],
    ["sellToleranceFrac", "number", "Sell floor tolerance", "The sell's minimum output sits this far under the curve's own quote."],
  ]],
  ["The human in the loop", [
    ["approvalTimeoutMs", "number", "Buy approval window (ms)", "A Phantom window that sits longer is abandoned; the launch is that much older."],
    ["sellReaskMs", "number", "Sell re-ask (ms)", "A declined or unanswered sell is asked again after this, while the determiner still says sell."],
    ["tickMs", "number", "Tick (ms)", "How often a live position is priced."],
  ]],
  ["New pools paired with an xStock, through Jupiter (off by default)", [
    ["xstockVenue", "checkbox", "Turn the venue on", `Polls public new-pool feeds for pools anywhere on Solana that pair a token with a stock you list below (or, with none listed, the built-in list — watch only). It follows the lane: Observe keeps would-have positions; Execute, armed, buys through Jupiter, <b>paid in that pool's stock</b> at that stock's ticket, canary and day cap, and sells on the same exits. Turning it on changes the arm sentence. <span class="rec">Unmeasured.</span> ${XSTOCK_UNMEASURED}`],
    ["xstockSources", "text", "Feeds", `Comma-separated: ${XSTOCK_SOURCES.join(", ")}. geckoterminal: the 20 newest Solana pools, cached 30–60 s, quick to answer 429. dexscreener: up to 30 pools per watched stock, liquidity-ordered, so a pool with no liquidity yet can be missed. jupiter-gems: the newest launchpad pools — undocumented, may change or stop without notice.`],
    ["xstockPollMs", "number", "Poll the feeds every (ms)", "15000 to 600000. The feeds' own caches are 30–60 s; polling faster only spends their rate limits."],
    ["xstockMaxPoolAgeMs", "number", "Oldest pool at first sight (ms)", "A pool first seen older than this is refused at notice_stale. The feeds see a pool a minute or more after it exists, and nothing has measured what age, if any, does better."],
    ["xstockSlippageBps", "number", "Jupiter slippage cap (bps)", "Written into the Jupiter instruction; the lane refuses a quote or transaction that says otherwise. 300 is the executor's live figure. 1 to 1000."],
    ["xstockMaxOpen", "number", "Would-have rows marked at once", "Every mark is one Jupiter request, and keyless Jupiter answers about one every two seconds; beyond this a cleared pool is recorded, not marked. 0 to 5."],
  ]],
  ["Shadow book", [
    ["forwardSamples", "number", "Forward samples", "How many samples a would-have row gets."],
    ["forwardIntervalMs", "number", "Sample interval (ms)", "How far apart. 12 × 5000 is a one-minute window."],
    ["shadowMaxOpen", "number", "Would-have rows sampled at once", "Beyond this a cleared launch is recorded but not sampled."],
    ["shadowCapacity", "number", "Rows kept", "For the scorecard and the export."],
  ]],
];

const $ = (id) => document.getElementById(id);
const form = $("form");
const msg = $("msg");
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ── THE STOCK LIST ─────────────────────────────────────────────────────────────────────
   One row per stock the lane may pay in, each number in THAT STOCK's units. The inputs
   carry data-q, not name, so the generic reader below never sees them; readStocks()
   builds the list and normalizeConfig is the fence, exactly as for every other dial. */
const STOCK_COLUMNS = [
  ["mint", "text", "Mint address"],
  ["symbol", "text", "Symbol"],
  ["maxPerTrade", "number", "Per launch"],
  ["minPerTrade", "number", "Canary (first buy)"],
  ["dailyCap", "number", "Per 24h"],
];
function stockRow(q = {}) {
  return `<tr class="stock">${STOCK_COLUMNS.map(([key, type, label]) =>
    `<td><input type="${type}" data-q="${key}" aria-label="${label}" value="${esc(q[key] ?? "")}" ${type === "number" ? 'step="any" min="0"' : 'spellcheck="false"'} ${key === "mint" ? 'class="mint"' : ""}></td>`).join("")}
    <td><button type="button" class="btn ghost" data-remove title="Remove this stock">×</button></td></tr>`;
}
function stockEditor(list) {
  return `<fieldset id="stockFieldset"><legend>Stock quotes (pump.fun Custom Pairs)</legend>
    <p class="help">A pump.fun launch can be priced in a tokenised stock (xStocks such as GLDx, TSLAx, SPYx) instead of SOL. Leave this empty and the lane stays SOL-only, as before. A stock listed here may be PAID with, from the stock already in your wallet: each number is in <b>that stock's units</b> (decimals are read from the mint account on chain, never typed). The network fee and account rent of a stock trade are still paid in SOL and count against your SOL per-24h cap. When the xStock venue above is on, a pool it finds pairing a token with a stock listed here is traded through Jupiter at these same numbers, charged to the same day.</p>
    <p class="help"><span class="rec">Canary rule.</span> ${esc(STOCK_CANARY_RULE)} Set the canary smaller than the per-launch ticket; blank means the canary IS the full ticket.</p>
    <p class="help">Nothing about stock-quoted launches has been measured: HAWK-AI's record is SOL launches only. Every xStock mint carries an issuer's freeze authority, pause switch and permanent delegate; the lane refuses a paused stock and says so, and cannot defend against a freeze. Changing this list changes the arm sentence, so an armed lane must be re-armed.</p>
    <table class="stocks"><thead><tr>${STOCK_COLUMNS.map(([, , label]) => `<th>${label}</th>`).join("")}<th></th></tr></thead>
      <tbody id="stockRows">${list.map(stockRow).join("")}</tbody></table>
    <div class="stockadd">${STOCK_FOCUS_CHOICES.map((k) => `<button type="button" class="btn ghost" data-add="${esc(k.mint)}" title="${esc(k.name)} — ${esc(k.mint)} — ${esc(k.sourceNote)}">+ ${esc(k.symbol)}${k.source === "fixture" ? "" : " *"}</button>`).join("")}
      <button type="button" class="btn ghost" data-add="">+ another mint</button>
      <span class="help">at most ${MAX_QUOTE_MINTS}; the address and symbol of each shortcut were read from its mint account on mainnet. * AAPLx and NVDAx were read over RPC on 2026-09-24 and are not in the vendored fixture; the lane checks each mint's own symbol on every read.</span></div>
  </fieldset>`;
}
function wireStockEditor() {
  const rows = $("stockRows");
  form.querySelector("#stockFieldset").addEventListener("click", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    if (t.hasAttribute("data-remove")) { t.closest("tr")?.remove(); return; }
    if (t.hasAttribute("data-add")) {
      const known = STOCK_FOCUS_CHOICES.find((k) => k.mint === t.dataset.add);
      if (known && rows.querySelector(`input[data-q="mint"][value="${known.mint}"]`)) { msg.className = "msg bad"; msg.textContent = `${known.symbol} is already listed`; return; }
      rows.insertAdjacentHTML("beforeend", stockRow(known ? { mint: known.mint, symbol: known.symbol } : {}));
      rows.lastElementChild?.querySelector(known ? 'input[data-q="maxPerTrade"]' : 'input[data-q="mint"]')?.focus();
    }
  });
}
function readStocks() {
  return [...form.querySelectorAll("#stockRows tr.stock")].map((tr) => {
    const q = {};
    for (const el of tr.querySelectorAll("[data-q]")) { const v = el.value.trim(); if (v !== "") q[el.dataset.q] = v; }
    return q;
  }).filter((q) => Object.keys(q).length > 0);
}

function build(config) {
  const preset = STYLE_PRESETS[config.stylePreset];
  form.innerHTML = `<fieldset><legend>First-run setup</legend><p class="help">${config.setupCompletedAt
    ? `Saved from the setup page${preset ? ` with the ${esc(preset.label)} style` : config.stylePreset === "custom" ? " with your own numbers" : ""}. Every number below stays yours to change.`
    : "Not run yet."} <a href="welcome.html" target="_blank">Run the setup again</a> — it saves into these same fields and puts the lane in Observe.</p></fieldset>` +
    FIELDS.map(([legend, fields]) => `<fieldset><legend>${legend}</legend>${fields.map(([key, type, label, help, choices]) => {
    const v = config[key];
    let input;
    if (type === "checkbox") input = `<input type="checkbox" name="${key}" ${v ? "checked" : ""}>`;
    else if (type === "select") input = `<select name="${key}">${(choices ?? CONSOLE_URLS.map((u) => [u, u])).map(([value, text]) => `<option value="${esc(value)}" ${value === v ? "selected" : ""}>${esc(text)}</option>`).join("")}</select>`;
    else input = `<input type="${type}" name="${key}" value="${v === null || v === undefined ? "" : String(v)}" ${type === "number" ? 'step="any"' : ""} spellcheck="false">`;
    return `<div class="field"><label>${label}<small>${key}</small></label><div>${input}</div><div class="help">${help}</div></div>`;
  }).join("")}</fieldset>`).join("") + stockEditor(config.quoteMints ?? []);
  wireStockEditor();
}
function read() {
  const out = {};
  for (const el of form.querySelectorAll("[name]")) {
    if (el.type === "checkbox") out[el.name] = el.checked;
    else out[el.name] = el.value === "" ? null : el.value;
  }
  out.quoteMints = readStocks();
  return out;
}
async function load() {
  const res = await chrome.runtime.sendMessage({ type: UI.GET_CONFIG });
  build(res?.ok ? res.config : CONFIG_DEFAULTS);
}
$("btnSave").addEventListener("click", async (e) => {
  e.preventDefault();
  for (const el of form.querySelectorAll(".bad")) el.classList.remove("bad");
  const draft = read();
  try { normalizeConfig({ ...CONFIG_DEFAULTS, ...draft }); }
  catch (error) {
    msg.className = "msg bad"; msg.textContent = error.message;
    const el = error.key === "quoteMints" ? form.querySelector("#stockFieldset") : form.querySelector(`[name="${error.key}"]`); if (el) { el.classList.add("bad"); el.focus?.(); }
    return;
  }
  const res = await chrome.runtime.sendMessage({ type: UI.SET_CONFIG, config: draft });
  if (!res?.ok) { msg.className = "msg bad"; msg.textContent = res?.error ?? "save failed"; const el = res?.key && (res.key === "quoteMints" ? form.querySelector("#stockFieldset") : form.querySelector(`[name="${res.key}"]`)); if (el) el.classList.add("bad"); return; }
  msg.className = "msg good"; msg.textContent = "saved — the lane reads it now";
  build(res.config);
});
$("btnDefaults").addEventListener("click", () => { build({ ...CONFIG_DEFAULTS, rpcUrl: read().rpcUrl ?? "" }); msg.className = "msg"; msg.textContent = "defaults shown (no stock quotes: SOL only) — press Save to keep them"; });
load();
