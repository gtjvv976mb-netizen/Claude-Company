/**
 * CLAUDE COMPANY — POLLING EXECUTOR
 *
 * The truly hands-off, still non-custodial auto-trader. It runs anywhere with
 * plain outbound internet — your laptop, a $4 VPS, a Raspberry Pi — with NO
 * public URL, no tunnel, no exposed port. It polls YOUR floor's calls over
 * HTTPS, holds YOUR burner wallet, obeys YOUR caps, and trades via Jupiter:
 * buy on entry, sell everything on exit. The desk never touches your keys —
 * the execution happens here, in your process.
 *
 * SAFETY, unchanged from the reference executor:
 *   - Burner wallet only. Fund it with what you're willing to lose entirely.
 *   - DRY RUN by default. Nothing trades until you set EXECUTE=1.
 *   - Per-trade and daily SOL caps, enforced locally.
 *
 * SETUP
 *   1) On your floor's Calls tab → Desk settings → Your executor: paste ANY
 *      https URL (it can be a dummy like https://example.com — the poller does
 *      not receive webhooks, it only needs the panel to mint your secret) and
 *      copy the signing secret.
 *   2) solana-keygen new -o burner.json   # then send it a little SOL
 *   3) npm install
 *   4) CC_SECRET=<secret> CC_FLOOR=<your floor number> \
 *      KEYPAIR=./burner.json MAX_SOL_PER_TRADE=0.05 DAILY_SOL_CAP=0.5 \
 *      EXECUTE=0 node poller.mjs        # watch it first; then EXECUTE=1
 */
import fs from "node:fs";
import { Connection, Keypair, VersionedTransaction, PublicKey } from "@solana/web3.js";

const API = (process.env.CC_API || "https://claude-company-api.onrender.com").replace(/\/$/, "");
const SECRET = process.env.CC_SECRET || "";
const FLOOR = process.env.CC_FLOOR || "";
const EXECUTE = process.env.EXECUTE === "1";
const MAX_SOL = Number(process.env.MAX_SOL_PER_TRADE || 0.05);
const DAILY_CAP = Number(process.env.DAILY_SOL_CAP || 0.5);
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS || 300);
const POLL_MS = Number(process.env.POLL_MS || 15000);
const RPC = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const WSOL = "So11111111111111111111111111111111111111112";
const CURSOR_FILE = process.env.CURSOR_FILE || "./.cc-cursor";

if (!SECRET || !FLOOR) { console.error("CC_SECRET and CC_FLOOR are required"); process.exit(1); }
const kp = (() => {
  const p = process.env.KEYPAIR || "./burner.json";
  if (!fs.existsSync(p)) { console.error(`no keypair at ${p} — solana-keygen new -o ${p}`); process.exit(1); }
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(p, "utf8"))));
})();
const conn = new Connection(RPC, "confirmed");
const log = (...a) => console.log(new Date().toISOString(), ...a);

let cursor = 0;
try { cursor = Number(fs.readFileSync(CURSOR_FILE, "utf8")) || 0; } catch {}
let spentToday = 0, dayStart = Date.now();

async function jupiterSwap({ inputMint, outputMint, amountRaw }) {
  const q = await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
    `&amount=${amountRaw}&slippageBps=${SLIPPAGE_BPS}`).then((r) => r.json());
  if (!q?.outAmount) throw new Error("no route");
  const s = await fetch("https://quote-api.jup.ag/v6/swap", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ quoteResponse: q, userPublicKey: kp.publicKey.toBase58(), wrapAndUnwrapSol: true }),
  }).then((r) => r.json());
  if (!s?.swapTransaction) throw new Error("no swap tx");
  const tx = VersionedTransaction.deserialize(Buffer.from(s.swapTransaction, "base64"));
  tx.sign([kp]);
  return conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
}

async function heldRaw(mint) {
  const r = await conn.getParsedTokenAccountsByOwner(kp.publicKey, { mint: new PublicKey(mint) });
  return r.value.reduce((a, v) => a + BigInt(v.account.data.parsed.info.tokenAmount.amount), 0n);
}

async function handle(ev) {
  if (Date.now() - dayStart > 86400e3) { spentToday = 0; dayStart = Date.now(); }
  if (ev.type === "entry") {
    const want = Math.min(Number(ev.size_sol || MAX_SOL), MAX_SOL);
    if (spentToday + want > DAILY_CAP) return log(`SKIP ${ev.symbol}: daily cap`);
    log(`ENTRY ${ev.symbol} (${ev.mint}) — ${want} SOL | stop ${ev.stop} target ${ev.target}`);
    if (!EXECUTE) return log("  DRY RUN");
    const sig = await jupiterSwap({ inputMint: WSOL, outputMint: ev.mint, amountRaw: Math.round(want * 1e9) });
    spentToday += want;
    log(`  BOUGHT — https://solscan.io/tx/${sig}`);
  } else if (ev.type === "exit") {
    log(`EXIT ${ev.symbol} (${ev.code}) — ${ev.urgency}`);
    if (!EXECUTE) return log("  DRY RUN");
    const bal = await heldRaw(ev.mint);
    if (bal <= 0n) return log("  nothing held");
    const sig = await jupiterSwap({ inputMint: ev.mint, outputMint: WSOL, amountRaw: bal.toString() });
    log(`  SOLD ALL — https://solscan.io/tx/${sig}`);
  }
}

async function tick() {
  try {
    const r = await fetch(`${API}/api/floor/${FLOOR}/executor/feed?after=${cursor}`,
      { headers: { authorization: "Bearer " + SECRET } });
    if (r.status === 401) return log("auth rejected — check CC_SECRET / CC_FLOOR");
    if (!r.ok) return;
    const { events = [] } = await r.json();
    for (const ev of events) {
      try { await handle(ev); } catch (e) { log(`ERROR on ${ev.symbol}:`, e.message); }
      cursor = Math.max(cursor, ev.id);
      try { fs.writeFileSync(CURSOR_FILE, String(cursor)); } catch {}
    }
  } catch (e) { log("poll error:", e.message); }
}

log(`poller up — floor ${FLOOR} — wallet ${kp.publicKey.toBase58()} — ${EXECUTE ? "LIVE" : "DRY RUN"} — ` +
  `max ${MAX_SOL} SOL/trade, ${DAILY_CAP}/day — polling every ${POLL_MS / 1000}s from cursor ${cursor}`);
await tick();
setInterval(tick, POLL_MS);
