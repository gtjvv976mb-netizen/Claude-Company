/**
 * How high did the coins actually go after HAWK-AI bought them?
 *
 * Price is read from the pump.fun TradeEvent's own virtual reserves (vSol / vToken),
 * which is the curve's canonical price at that instant — no external feed, no guess.
 *
 * SAMPLED, and that direction matters: for each mint the curve's full trade list is
 * fetched (1 cheap call) and up to SAMPLE transactions are read, spread evenly across
 * the coin's life after the bot's entry. A sampled maximum can only UNDERSTATE the true
 * peak, never overstate it. Reading all of them is ~60,000 requests.
 */
import fs from "node:fs";
import bs58 from "./node_modules/bs58/index.js";
import { PublicKey } from "@solana/web3.js";
import { decodeTradeEvent, TRADE_EVENT_DISCRIMINATOR } from "./snipe-venue-pumpfun.mjs";

const SCRATCH = "/tmp/claude-0/-home-user-Claude-Company-Solana/8c821c00-cdc3-53f7-8027-87a1481fca10/scratchpad";
const PUMP = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const SAMPLE = Number(process.env.SAMPLE || 22);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch("https://api.mainnet-beta.solana.com", { method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      if (res.status === 429) { await sleep(800 * (i + 1)); continue; }
      const b = await res.json();
      if (b.error) { await sleep(600 * (i + 1)); continue; }
      return b.result;
    } catch { await sleep(600 * (i + 1)); }
  }
  return null;
}

const legs = JSON.parse(fs.readFileSync(`${SCRATCH}/legs.json`, "utf8"));
const trips = JSON.parse(fs.readFileSync(`${SCRATCH}/trips.json`, "utf8"));
const tripOf = new Map(trips.map((t) => [t.mint, t]));
const buys = legs.filter((l) => l.kind === "buy");
const curveOf = (mint) => PublicKey.findProgramAddressSync(
  [Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()], PUMP)[0].toBase58();

/** Every TradeEvent price in a transaction, from the event's own virtual reserves. */
function pricesIn(t) {
  const keys = (t.transaction.message.accountKeys || []).map((k) => (typeof k === "string" ? k : k.pubkey));
  const out = [];
  const visit = (ix) => {
    const pid = ix.programId || keys[ix.programIdIndex];
    if (String(pid) !== PUMP.toBase58()) return;
    if (!ix.data) return;
    let d; try { d = Buffer.from(bs58.decode(ix.data)); } catch { return; }
    /* A CPI event log is 8 bytes of Anchor's event wrapper and then the event itself. */
    for (const slice of [d, d.subarray(8)]) {
      if (!slice || slice.length < 8) continue;
      if (slice.subarray(0, 8).toString("hex") !== TRADE_EVENT_DISCRIMINATOR) continue;
      try {
        const e = decodeTradeEvent(slice);
        const v = Number(e.vQuoteRaw) / Number(e.vBaseRaw);
        if (Number.isFinite(v) && v > 0) out.push({ price: v, ts: Number(e.timestamp) * 1000 });
      } catch {}
    }
  };
  for (const ix of t.transaction.message.instructions || []) visit(ix);
  for (const g of t.meta?.innerInstructions || []) for (const ix of g.instructions || []) visit(ix);
  return out;
}

const rows = [];
for (let n = 0; n < buys.length; n++) {
  const b = buys[n];
  const entryPrice = Math.abs(b.lamports) / Number(b.tokens);   // lamports per raw token
  const sigs = await rpc("getSignaturesForAddress", [curveOf(b.mint), { limit: 1000 }]);
  if (!sigs?.length) { process.stderr.write(`${n + 1}/${buys.length} no history\r`); continue; }
  /* Only what happened AT OR AFTER the bot's entry — the rise it could have caught. */
  const after = sigs.filter((s) => s.blockTime * 1000 >= b.ts - 5000 && !s.err)
    .sort((a, c) => a.blockTime - c.blockTime);
  if (!after.length) continue;
  const step = Math.max(1, Math.floor(after.length / SAMPLE));
  const picked = after.filter((_, i) => i % step === 0).slice(0, SAMPLE);
  let peak = entryPrice, peakTs = b.ts, last = null;
  for (const s of picked) {
    const t = await rpc("getTransaction", [s.signature, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }]);
    if (!t) continue;
    for (const p of pricesIn(t)) {
      if (p.price > peak) { peak = p.price; peakTs = p.ts || s.blockTime * 1000; }
      last = p.price;
    }
    await sleep(70);
  }
  const trip = tripOf.get(b.mint);
  rows.push({
    mint: b.mint, entryPrice, peak, last,
    peakX: peak / entryPrice,
    finalX: last ? last / entryPrice : null,
    msToPeak: peakTs - b.ts,
    trades: after.length, sampled: picked.length,
    realizedPct: trip && trip.sizeSol > 0 ? (trip.realizedSol / trip.sizeSol) * 100 : null,
    holdMs: trip?.holdMs ?? null,
  });
  process.stderr.write(`${n + 1}/${buys.length} ${b.mint.slice(0, 6)}… peak ${(peak / entryPrice).toFixed(2)}x\r`);
}
fs.writeFileSync(`${SCRATCH}/peaks.json`, JSON.stringify(rows, null, 1));
console.log(`\nwrote ${rows.length} mints`);
