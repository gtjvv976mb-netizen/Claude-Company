/**
 * CLAUDE COMPANY — POLLING EXECUTOR (risk-managed)
 *
 * Hands-off auto-trading that never asks for your keys. Runs anywhere with plain
 * outbound internet — your laptop, a $4 VPS, a Raspberry Pi — with NO public URL,
 * no tunnel, no exposed port. It polls YOUR floor's calls over HTTPS, holds YOUR
 * burner wallet, obeys YOUR caps, and trades via Jupiter.
 *
 * It does not just relay the desk. Between the desk's entry and its exit it runs
 * its own risk engine (strategy.mjs, tuned by simulation in tune.mjs):
 *
 *   - a hard STOP checked every poll, so a rug at 3am does not wait for the desk
 *   - a TRAIL that arms once the call's target is touched and ratchets up behind
 *     the high, so a runner is not round-tripped
 *   - the DESK'S OWN EXIT always wins and sells everything
 *   - DAILY LOSS LIMIT and MAX OPEN POSITIONS, the two brakes that decide whether
 *     a bot survives a bad week
 *
 * Marks are taken from an executable Jupiter quote for the exact size held — not
 * a mid price — so the stop fires on what you could actually sell for.
 *
 * State (positions, daily counters, cursor) is persisted, so a restart resumes
 * managing open trades instead of orphaning them.
 *
 * SAFETY: burner wallet only; DRY RUN by default (EXECUTE=1 to arm); every cap
 * enforced locally and never trusted from the wire.
 *
 * SETUP
 *   1) Floor's Calls tab -> Desk settings -> Your executor: copy the signing secret.
 *   2) solana-keygen new -o burner.json   (or let install.sh make one) and fund it.
 *   3) npm install
 *   4) CC_SECRET=<secret> CC_FLOOR=<n> KEYPAIR=./burner.json EXECUTE=0 node poller.mjs
 */
import fs from "node:fs";
import { Connection, Keypair, VersionedTransaction, PublicKey } from "@solana/web3.js";
import { DEFAULTS, planEntry, openPosition, stepPosition, rollDay, freshState } from "./strategy.mjs";

const API = (process.env.CC_API || "https://claude-company-api.onrender.com").replace(/\/$/, "");
const SECRET = process.env.CC_SECRET || "";
const FLOOR = process.env.CC_FLOOR || "";
const EXECUTE = process.env.EXECUTE === "1";
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS || 300);
const POLL_MS = Number(process.env.POLL_MS || 15000);
const FEE_RESERVE = Number(process.env.FEE_RESERVE_SOL || 0.01);
const RPC = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const WSOL = "So11111111111111111111111111111111111111112";
const STATE_FILE = process.env.STATE_FILE || "./.cc-state.json";
const LAMPORTS = 1e9;

const CFG = {
  ...DEFAULTS,
  maxSolPerTrade: Number(process.env.MAX_SOL_PER_TRADE || DEFAULTS.maxSolPerTrade),
  dailySolCap: Number(process.env.DAILY_SOL_CAP || DEFAULTS.dailySolCap),
  dailyLossLimitSol: Number(process.env.DAILY_LOSS_LIMIT_SOL || DEFAULTS.dailyLossLimitSol),
  maxOpenPositions: Number(process.env.MAX_OPEN_POSITIONS || DEFAULTS.maxOpenPositions),
  trailPct: Number(process.env.TRAIL_PCT || DEFAULTS.trailPct),
  scaleOutPct: Number(process.env.SCALE_OUT_PCT ?? DEFAULTS.scaleOutPct),
};

if (!SECRET || !FLOOR) { console.error("CC_SECRET and CC_FLOOR are required"); process.exit(1); }
const kp = (() => {
  const p = process.env.KEYPAIR || "./burner.json";
  if (!fs.existsSync(p)) { console.error(`no keypair at ${p} — solana-keygen new -o ${p}`); process.exit(1); }
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(p, "utf8"))));
})();
const conn = new Connection(RPC, "confirmed");
const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ── persisted state: cursor, positions, daily counters ───────────────────── */
let S = { cursor: 0, positions: {}, state: freshState(Date.now()) };
try { S = { ...S, ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) }; } catch {}
S.state = { ...freshState(Date.now()), ...(S.state || {}) };
const save = () => { try { fs.writeFileSync(STATE_FILE, JSON.stringify(S, null, 2)); } catch (e) { log("state save failed:", e.message); } };
const openList = () => Object.values(S.positions);

/* ── Jupiter ──────────────────────────────────────────────────────────────── */
const JUP = "https://quote-api.jup.ag/v6";
async function quote(inputMint, outputMint, amountRaw) {
  const r = await fetch(`${JUP}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${SLIPPAGE_BPS}`);
  if (!r.ok) throw new Error(`quote ${r.status}`);
  const q = await r.json();
  if (!q?.outAmount) throw new Error("no route");
  return q;
}
async function swap(q) {
  const r = await fetch(`${JUP}/swap`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ quoteResponse: q, userPublicKey: kp.publicKey.toBase58(), wrapAndUnwrapSol: true }) });
  const s = await r.json();
  if (!s?.swapTransaction) throw new Error("no swap tx");
  const tx = VersionedTransaction.deserialize(Buffer.from(s.swapTransaction, "base64"));
  tx.sign([kp]);
  return conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
}
async function heldRaw(mint) {
  const r = await conn.getParsedTokenAccountsByOwner(kp.publicKey, { mint: new PublicKey(mint) });
  return r.value.reduce((a, v) => a + BigInt(v.account.data.parsed.info.tokenAmount.amount), 0n);
}
async function solBalance() {
  return (await conn.getBalance(kp.publicKey)) / LAMPORTS;
}

/* ── entries ──────────────────────────────────────────────────────────────── */
async function onEntry(ev) {
  if (S.positions[ev.mint]) return log(`SKIP ${ev.symbol}: already holding`);
  rollDay(S.state, Date.now());
  S.state.openCount = openList().length;
  S.state.spendableSol = EXECUTE ? Math.max(0, (await solBalance()) - FEE_RESERVE) : Infinity;

  const plan = planEntry({ call: ev, cfg: CFG, state: S.state });
  if (plan.action !== "buy") return log(`SKIP ${ev.symbol}: ${plan.reason}`);

  log(`ENTRY ${ev.symbol} — ${plan.sol} SOL | stop ${ev.stop} target ${ev.target}`);
  if (!EXECUTE) return log("  DRY RUN");

  const q = await quote(WSOL, ev.mint, Math.round(plan.sol * LAMPORTS));
  const sig = await swap(q);
  // Marks are normalised to the entry (entry = 1.0), so the engine compares
  // executable value against value and never has to know token decimals.
  const pos = openPosition({
    call: { ...ev, stop: ev.entry_ref ? ev.stop / ev.entry_ref : 0.62,
            target: ev.entry_ref && ev.target ? ev.target / ev.entry_ref : null },
    sol: plan.sol, fillPrice: 1, cfg: CFG,
  });
  pos.qtyRaw = String(q.outAmount);
  pos.paidSol = plan.sol;
  S.positions[ev.mint] = pos;
  S.state.deployedTodaySol += plan.sol;
  save();
  log(`  BOUGHT ${ev.symbol} — https://solscan.io/tx/${sig}`);
}

/* ── exits: the desk's, and our own ───────────────────────────────────────── */
async function sellAll(pos, why, fraction = 1) {
  const held = EXECUTE ? await heldRaw(pos.mint) : BigInt(pos.qtyRaw || 0);
  const amt = fraction >= 1 ? held : (held * BigInt(Math.round(fraction * 1e6))) / 1000000n;
  if (amt <= 0n) { delete S.positions[pos.mint]; save(); return log(`  nothing held in ${pos.symbol}`); }
  log(`EXIT ${pos.symbol} — ${why}`);
  if (!EXECUTE) { if (fraction >= 1) delete S.positions[pos.mint]; save(); return log("  DRY RUN"); }

  const q = await quote(pos.mint, WSOL, amt.toString());
  const outSol = Number(q.outAmount) / LAMPORTS;
  const sig = await swap(q);
  if (fraction >= 1) {
    const net = outSol - (pos.paidSol || 0);
    S.state.realizedTodaySol += net;
    delete S.positions[pos.mint];
    log(`  SOLD ${pos.symbol} for ${outSol.toFixed(4)} SOL (${net >= 0 ? "+" : ""}${net.toFixed(4)}) — https://solscan.io/tx/${sig}`);
  } else {
    pos.qtyRaw = String(BigInt(pos.qtyRaw) - amt);
    log(`  SCALED ${pos.symbol} — https://solscan.io/tx/${sig}`);
  }
  save();
}

/** The risk pass: price every open position and let the engine decide. */
async function manageOpen() {
  for (const pos of openList()) {
    try {
      let mark = null;
      if (pos.qtyRaw && BigInt(pos.qtyRaw) > 0n) {
        const q = await quote(pos.mint, WSOL, pos.qtyRaw).catch(() => null);
        // value now, against value paid — an executable mark, not a mid price
        if (q) mark = (Number(q.outAmount) / LAMPORTS) / (pos.paidSol || 1);
      }
      const d = stepPosition({ pos, mark, deskExit: null, cfg: CFG });
      if (d.action === "sell") await sellAll(pos, d.reason);
      else if (d.action === "sell_part") await sellAll(pos, d.reason, d.fraction);
      else save();                       // persist trail/stop ratchets
    } catch (e) { log(`manage ${pos.symbol}: ${e.message}`); }
  }
}

/* ── the loop ─────────────────────────────────────────────────────────────── */
async function tick() {
  try {
    const r = await fetch(`${API}/api/floor/${FLOOR}/executor/feed?after=${S.cursor}`,
      { headers: { authorization: "Bearer " + SECRET } });
    if (r.status === 401) return log("auth rejected — check CC_SECRET / CC_FLOOR");
    if (r.ok) {
      const { events = [] } = await r.json();
      for (const ev of events) {
        try {
          if (ev.type === "entry") await onEntry(ev);
          else if (ev.type === "exit") {
            const pos = S.positions[ev.mint];
            if (pos) await sellAll(pos, `desk exit (${ev.code || "exit"})`);
            else log(`EXIT ${ev.symbol} — not held`);
          }
        } catch (e) { log(`ERROR on ${ev.symbol}: ${e.message}`); }
        S.cursor = Math.max(S.cursor, ev.id);
        save();
      }
    }
  } catch (e) { log("poll error:", e.message); }
  await manageOpen();                    // always run risk, even if the feed failed
}

log(`poller up — floor ${FLOOR} — wallet ${kp.publicKey.toBase58()} — ${EXECUTE ? "LIVE" : "DRY RUN"}`);
log(`  caps: ${CFG.maxSolPerTrade} SOL/trade, ${CFG.dailySolCap}/day deploy, ` +
    `${CFG.dailyLossLimitSol} daily loss limit, ${CFG.maxOpenPositions} open max`);
log(`  risk: hard stop + ${(CFG.trailPct * 100).toFixed(0)}% trail once target is touched` +
    (CFG.scaleOutPct > 0 ? `, ${(CFG.scaleOutPct * 100).toFixed(0)}% scale-out` : ", no scale-out (ride the runners)"));
log(`  resuming ${openList().length} open position(s) from cursor ${S.cursor}`);
await tick();
setInterval(tick, POLL_MS);
