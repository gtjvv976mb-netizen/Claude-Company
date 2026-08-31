/**
 * CLAUDE COMPANY — POLLING EXECUTOR (dry-run hardening release)
 *
 * Runs anywhere with outbound internet and no public URL. It polls YOUR floor's
 * calls over HTTPS, evaluates local caps, and logs decisions. EXECUTE=1 is rejected
 * until the durable transaction engine is complete and separately canary-tested.
 *
 * It does not just relay the desk. Between the desk's entry and its exit it runs
 * its own risk engine (strategy.mjs, tuned by simulation in tune.mjs):
 *
 *   - a hard STOP checked every poll, so a rug at 3am does not wait for the desk
 *   - a TRAIL that arms at 1.5x and ratchets up behind
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
 * SAFETY: this release is DRY RUN only and rejects EXECUTE=1 until the durable
 * transaction engine is complete. Caps remain local and are never trusted from wire.
 *
 * SETUP
 *   1) Floor's Calls tab -> Desk settings -> Your executor: copy the signing secret.
 *   2) solana-keygen new -o burner.json   (or let install.sh make one). Do not fund it.
 *   3) npm install
 *   4) CC_SECRET=<secret> CC_FLOOR=<n> KEYPAIR=./burner.json EXECUTE=0 node poller.mjs
 */
import fs from "node:fs";
import { Connection, Keypair, VersionedTransaction, PublicKey } from "@solana/web3.js";
import { DEFAULTS, planEntry, openPosition, stepPosition, rollDay, freshState } from "./strategy.mjs";
import { policyConfigForPosition, resolveTakeProfitRule } from "./trade-policy.mjs";

const API = (process.env.CC_API || "https://claude-company-api.onrender.com").replace(/\/$/, "");
const SECRET = process.env.CC_SECRET || "";
const FLOOR = process.env.CC_FLOOR || "";
const EXECUTE = process.env.EXECUTE === "1";
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS || 300);
const POLL_MS = Number(process.env.POLL_MS || 15000);
const FEE_RESERVE = Number(process.env.FEE_RESERVE_SOL || 0.01);
const PRIORITY_FEE = Number(process.env.PRIORITY_FEE_LAMPORTS || 200000);
const MAX_CALL_AGE_MS = Number(process.env.MAX_CALL_AGE_MIN || 45) * 60000;
const RPC = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const WSOL = "So11111111111111111111111111111111111111112";
const STATE_FILE = process.env.STATE_FILE || "./.cc-state.json";
const LAMPORTS = 1e9;

// This release hardens the research/paper path but does not yet ship the durable
// transaction WAL and instruction-level Jupiter validation required for unattended
// custody. Fail closed instead of presenting an experimental signer as production.
if (EXECUTE) {
  console.error("LIVE execution is intentionally disabled in this release; run with EXECUTE=0 while the durable transaction engine is completed and canary-tested.");
  process.exit(1);
}

const CFG = {
  ...DEFAULTS,
  maxSolPerTrade: Number(process.env.MAX_SOL_PER_TRADE || DEFAULTS.maxSolPerTrade),
  dailySolCap: Number(process.env.DAILY_SOL_CAP || DEFAULTS.dailySolCap),
  dailyLossLimitSol: Number(process.env.DAILY_LOSS_LIMIT_SOL || DEFAULTS.dailyLossLimitSol),
  maxOpenPositions: Number(process.env.MAX_OPEN_POSITIONS || DEFAULTS.maxOpenPositions),
  trailPct: Number(process.env.TRAIL_PCT || DEFAULTS.trailPct),
  // the sizing rails, tunable without a deploy so they can be tightened as the
  // wallet grows and the sample arrives
  fDefault: Number(process.env.F_DEFAULT || DEFAULTS.fDefault),
  fNameMax: Number(process.env.F_NAME_MAX || DEFAULTS.fNameMax),
  bookHeatMax: Number(process.env.BOOK_HEAT_MAX || DEFAULTS.bookHeatMax),
  maxAgeHours: Number(process.env.MAX_AGE_HOURS || DEFAULTS.maxAgeHours),
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
let S = { cursor: 0, positions: {}, state: freshState(Date.now()), primed: false };
if (fs.existsSync(STATE_FILE)) {
  try { S = { ...S, ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) }; }
  catch (e) {
    console.error(`state file is unreadable; refusing to overwrite it: ${e.message}`);
    process.exit(1);
  }
}
S.state = { ...freshState(Date.now()), ...(S.state || {}) };
const save = () => {
  const tmp = `${STATE_FILE}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(S, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, STATE_FILE);
    try { fs.chmodSync(STATE_FILE, 0o600); } catch {}
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw new Error(`state save failed: ${e.message}`);
  }
};
const openList = () => Object.values(S.positions);

/* ── Jupiter ──────────────────────────────────────────────────────────────── */
const JUP = (process.env.JUPITER_API_BASE || "https://lite-api.jup.ag/swap/v1").replace(/\/$/, "");
const JUP_HEADERS = process.env.JUPITER_API_KEY ? { "x-api-key": process.env.JUPITER_API_KEY } : {};
async function quote(inputMint, outputMint, amountRaw) {
  const qs = new URLSearchParams({ inputMint, outputMint, amount: String(amountRaw), slippageBps: String(SLIPPAGE_BPS) });
  const r = await fetch(`${JUP}/quote?${qs}`, { headers: JUP_HEADERS, redirect: "error", signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`quote ${r.status}`);
  const q = await r.json();
  if (!q?.outAmount) throw new Error("no route");
  return q;
}
async function swap(q) {
  const r = await fetch(`${JUP}/swap`, { method: "POST", headers: { "content-type": "application/json", ...JUP_HEADERS },
    redirect: "error", signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ quoteResponse: q, userPublicKey: kp.publicKey.toBase58(), wrapAndUnwrapSol: true,
      // Without a priority fee a swap frequently never lands under congestion —
      // and an exit that never lands is a position you still own.
      prioritizationFeeLamports: PRIORITY_FEE, dynamicComputeUnitLimit: true }) });
  const s = await r.json();
  if (!r.ok) throw new Error(`swap build ${r.status}`);
  if (s?.simulationError) throw new Error(`Jupiter simulation failed: ${JSON.stringify(s.simulationError)}`);
  if (!s?.swapTransaction) throw new Error("no swap tx");
  if (!Number.isFinite(Number(s.lastValidBlockHeight))) throw new Error("swap response omitted lastValidBlockHeight");
  const tx = VersionedTransaction.deserialize(Buffer.from(s.swapTransaction, "base64"));
  tx.sign([kp]);
  const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  // sendRawTransaction returns as soon as the RPC ACCEPTS the bytes — it says
  // nothing about whether the swap succeeded. A slippage breach lands on-chain as
  // a FAILED transaction and still yields a signature, so logging "BOUGHT" here
  // (and charging the daily cap) would report trades that never happened.
  const st = await conn.confirmTransaction(
    { signature: sig, blockhash: tx.message.recentBlockhash,
      lastValidBlockHeight: Number(s.lastValidBlockHeight) }, "confirmed");
  if (st?.value?.err) throw new Error(`swap failed on-chain: ${JSON.stringify(st.value.err)}`);
  return sig;
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
  // A backlog is not a trading opportunity. After downtime the feed replays every
  // entry since the cursor, and market-buying a call published hours ago means
  // buying a move that already happened — or a coin that is already dead.
  const age = Date.now() - (ev.ts || 0);
  if (ev.ts && age > MAX_CALL_AGE_MS)
    return log(`SKIP ${ev.symbol}: call is ${Math.round(age / 60000)}m old (max ${MAX_CALL_AGE_MS / 60000}m)`);
  rollDay(S.state, Date.now());
  S.state.openCount = openList().length;
  S.state.spendableSol = EXECUTE ? Math.max(0, (await solBalance()) - FEE_RESERVE) : Infinity;
  // Kelly needs an equity base, a closed sample, and the risk the book already
  // carries. Equity is the wallet itself — the only honest number here.
  S.state.equitySol = EXECUTE ? await solBalance() : (S.state.equitySol ?? CFG.dailySolCap);
  S.state.wins = S.wins ?? 0;
  S.state.losses = S.losses ?? 0;
  S.state.bookHeat = openList().reduce((a, p) => a + (p.riskF || 0), 0);

  /* THE FLOOR'S OWN RULE, AS OF THIS POLL.
   *
   * take_profit_x rides on the event rather than living in this process's env, so a
   * tenant switching "sell at 2x" to "ride to 10x" in the UI takes effect on the next
   * poll instead of on the next redeploy of their VPS. 0 means auto — use the
   * shared snipe-v2 default 2x rule and honor the authored target. An explicit
   * multiple overrides the target; the desk's explicit exit always still wins. */
  const takeProfitRule = resolveTakeProfitRule(ev.take_profit_x, CFG.takeProfitX);
  const { takeProfitX: tpx, honorDeskTarget } = takeProfitRule;
  const explicitTpx = !honorDeskTarget;
  const fixed = Number(ev.fixed_sol) > 0
    ? Math.min(Number(ev.fixed_sol), CFG.maxSolPerTrade) : CFG.fixedSol;
  const perCall = { ...CFG, ...takeProfitRule, fixedSol: fixed };
  const plan = planEntry({ call: ev, cfg: perCall, state: S.state });
  if (plan.action !== "buy") return log(`SKIP ${ev.symbol}: ${plan.reason}`);

  log(`ENTRY ${ev.symbol} — ${plan.sol} SOL | stop ${ev.stop} target ${ev.target}` +
      (explicitTpx ? ` | explicit full exit at ${tpx}x`
        : ` | auto full exit at ${tpx}x or the desk target, whichever comes first`));
  if (!EXECUTE) return log("  DRY RUN");

  const q = await quote(WSOL, ev.mint, Math.round(plan.sol * LAMPORTS));
  const sig = await swap(q);
  // Marks are normalised to the entry (entry = 1.0), so the engine compares
  // executable value against value and never has to know token decimals.
  const pos = openPosition({
    call: { ...ev, stop: ev.entry_ref ? ev.stop / ev.entry_ref : 0.62,
            target: ev.entry_ref && ev.target ? ev.target / ev.entry_ref : null },
    sol: plan.sol, fillPrice: 1, cfg: perCall,
  });
  pos.qtyRaw = String(q.outAmount);
  pos.paidSol = plan.sol;
  pos.riskF = plan.f ?? null;              // this name's share of book heat
  pos.openedAtMs = Date.now();
  /* The rule IN FORCE WHEN THIS OPENED, remembered on the position. A trade should be
   * closed by the rule it was entered under: someone changing their mind at 1.9x must
   * not retroactively rewrite a position already on its way to a double. */
  Object.assign(pos, takeProfitRule);
  S.positions[ev.mint] = pos;
  S.state.deployedTodaySol += plan.sol;
  save();
  log(`  BOUGHT ${ev.symbol} — https://solscan.io/tx/${sig}`);
}

/* ── exits: the desk's, and our own ───────────────────────────────────────── */
async function sellAll(pos, why, fraction = 1) {
  // An operator may upgrade with an old state file that still represents a real
  // holding. This dry-run-only release must never retire that state without the
  // corresponding on-chain sale; preserve it for explicit manual reconciliation.
  if (!EXECUTE) return log(`DRY RUN EXIT ${pos.symbol} — ${why} — position retained; no transaction sent`);

  const held = await heldRaw(pos.mint);
  // Never liquidate tokens that predated this call. The tracked position is the
  // maximum this executor is authorized to sell, even if the burner holds more.
  const tracked = BigInt(pos.qtyRaw || 0);
  const scoped = held < tracked ? held : tracked;
  const amt = fraction >= 1 ? scoped : (scoped * BigInt(Math.round(fraction * 1e6))) / 1000000n;
  if (amt <= 0n) {
    // Do NOT drop the position here. "Balance reads zero" is not the same as "we
    // own nothing": the buy may be a slot away from confirmation, or the RPC may
    // be flaky. Dropping it would remove the bag from the stop/trail engine and
    // leave a real position unmanaged and unsellable. Keep it and retry next tick;
    // only retire it once the chain has repeatedly said empty.
    pos.emptyReads = (pos.emptyReads || 0) + 1;
    if (pos.emptyReads >= 3) { delete S.positions[pos.mint]; log(`  ${pos.symbol}: empty on 3 reads — retiring`); }
    save();
    return log(`  nothing held in ${pos.symbol} (read ${pos.emptyReads}/3) — keeping the position`);
  }
  pos.emptyReads = 0;
  log(`EXIT ${pos.symbol} — ${why}`);

  const q = await quote(pos.mint, WSOL, amt.toString());
  const outSol = Number(q.outAmount) / LAMPORTS;
  const sig = await swap(q);
  if (fraction >= 1) {
    const net = outSol - (pos.paidSol || 0);
    S.state.realizedTodaySol += net;
    // the closed sample Kelly reads next time
    if (net >= 0) S.wins = (S.wins || 0) + 1; else S.losses = (S.losses || 0) + 1;
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
      // Judged by the rule it was opened under, not whatever the UI says right now.
      const d = stepPosition({ pos, mark, deskExit: null,
        cfg: policyConfigForPosition(pos, CFG) });
      if (d.action === "sell") await sellAll(pos, d.reason);
      else if (d.action === "sell_part") await sellAll(pos, d.reason, d.fraction);
      else save();                       // persist trail/stop ratchets
    } catch (e) { log(`manage ${pos.symbol}: ${e.message}`); }
  }
}

/* ── the loop ─────────────────────────────────────────────────────────────── */
let ticking = false;
async function tick() {
  // A slow tick (confirmations, many positions) must not overlap the next one:
  // the second would re-fetch from the stale cursor and buy the same call twice.
  if (ticking) return;
  ticking = true;
  try {
    try {
      const r = await fetch(`${API}/api/floor/${FLOOR}/executor/feed?after=${S.cursor}`,
        { headers: { authorization: "Bearer " + SECRET }, signal: AbortSignal.timeout(10000) });
      if (r.status === 401) log("auth rejected — check CC_SECRET / CC_FLOOR");
      else if (r.ok) {
        const payload = await r.json();
        const events = payload.events || [];
        // FIRST RUN adopts the server's true latest id, not merely the first 50-row
        // page. Otherwise a large history can leak into later polls as fresh entries.
        if (!S.primed) {
          const previousCursor = S.cursor;
          S.primed = true;
          S.cursor = Math.max(S.cursor, Number(payload.latest_id) || 0);
          log(`primed at cursor ${S.cursor} — ${events.length} historic event(s) skipped, trading forward only`);
          try { save(); }
          catch (e) { S.primed = false; S.cursor = previousCursor; throw e; }
        } else {
          for (const ev of events) {
            try {
              if (ev.type === "entry") await onEntry(ev);
              else if (ev.type === "exit") {
                const pos = S.positions[ev.mint];
                if (pos) await sellAll(pos, `desk exit (${ev.code || "exit"})`);
                else log(`EXIT ${ev.symbol} — not held`);
              } else throw new Error(`unknown event type ${ev.type}`);
              // Cursor is an acknowledgement: advance only after the action succeeded
              // or deliberately skipped. A thrown buy/sell remains retryable.
              const previousCursor = S.cursor;
              S.cursor = Math.max(S.cursor, ev.id);
              try { save(); }
              catch (e) { S.cursor = previousCursor; throw e; }
            } catch (e) {
              log(`ERROR on ${ev.symbol}: ${e.message} — event remains pending`);
              break;
            }
          }
        }
      }
    } catch (e) { log("poll error:", e.message); }
    try { await manageOpen(); }          // auth/feed failure never disables local stops
    catch (e) { log("manage error:", e.message); }
  } finally {
    ticking = false;                     // every return/error releases the next tick
  }
}

log(`poller up — floor ${FLOOR} — wallet ${kp.publicKey.toBase58()} — ${EXECUTE ? "LIVE" : "DRY RUN"}`);
log(`  caps: ${CFG.maxSolPerTrade} SOL/trade, ${CFG.dailySolCap}/day deploy, ` +
    `${CFG.dailyLossLimitSol} daily loss limit, ${CFG.maxOpenPositions} open max`);
log(`  risk: full exit at desk target/default ${CFG.takeProfitX}x, breakeven at 1.35x, ` +
    `${(CFG.trailPct * 100).toFixed(0)}% trail from 1.5x, no partial exits`);
log(`  resuming ${openList().length} open position(s) from cursor ${S.cursor}`);
await tick();
setInterval(tick, POLL_MS);
