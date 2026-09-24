/** THE OPTIONS PAGE: every config key, described, validated by the same normalizeConfig the engine runs. */
import { UI } from "../lib/protocol.mjs";
import { CONFIG_DEFAULTS, CONSOLE_URLS, normalizeConfig, RECORD } from "../lib/config.mjs";

const FIELDS = [
  ["Connection", [
    ["rpcUrl", "text", "RPC (https)", "Helius, Triton or QuickNode. The public mainnet RPC refuses browsers. Reads, simulations and sends all go here."],
    ["rpcWsUrl", "text", "RPC websocket (wss)", "Blank derives it from the https URL. The feed is one logsSubscribe on the pump.fun program."],
    ["secondaryRpcUrl", "text", "Second RPC (optional)", "When set, both providers must agree on the curve before a mark is trusted, as WALL-ST-E requires."],
    ["consoleUrl", "select", "Console page", "The page Phantom lives on; the extension is built for these pages only. Keep that tab open."],
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

function build(config) {
  form.innerHTML = FIELDS.map(([legend, fields]) => `<fieldset><legend>${legend}</legend>${fields.map(([key, type, label, help]) => {
    const v = config[key];
    let input;
    if (type === "checkbox") input = `<input type="checkbox" name="${key}" ${v ? "checked" : ""}>`;
    else if (type === "select") input = `<select name="${key}">${CONSOLE_URLS.map((u) => `<option value="${u}" ${u === v ? "selected" : ""}>${u}</option>`).join("")}</select>`;
    else input = `<input type="${type}" name="${key}" value="${v === null || v === undefined ? "" : String(v)}" ${type === "number" ? 'step="any"' : ""} spellcheck="false">`;
    return `<div class="field"><label>${label}<small>${key}</small></label><div>${input}</div><div class="help">${help}</div></div>`;
  }).join("")}</fieldset>`).join("");
}
function read() {
  const out = {};
  for (const el of form.querySelectorAll("[name]")) {
    if (el.type === "checkbox") out[el.name] = el.checked;
    else out[el.name] = el.value === "" ? null : el.value;
  }
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
    const el = form.querySelector(`[name="${error.key}"]`); if (el) { el.classList.add("bad"); el.focus(); }
    return;
  }
  const res = await chrome.runtime.sendMessage({ type: UI.SET_CONFIG, config: draft });
  if (!res?.ok) { msg.className = "msg bad"; msg.textContent = res?.error ?? "save failed"; const el = res?.key && form.querySelector(`[name="${res.key}"]`); if (el) el.classList.add("bad"); return; }
  msg.className = "msg good"; msg.textContent = "saved — the lane reads it now";
  build(res.config);
});
$("btnDefaults").addEventListener("click", () => { build({ ...CONFIG_DEFAULTS, rpcUrl: read().rpcUrl ?? "" }); msg.className = "msg"; msg.textContent = "defaults shown — press Save to keep them"; });
load();
