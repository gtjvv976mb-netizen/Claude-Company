import fs from "node:fs";
import path from "node:path";
import { ROOT, cfg, MINTS } from "./config.js";
import * as gmgn from "./data/gmgn.js";
import { emit } from "./lib/bus.js";

const JUP = "https://lite-api.jup.ag";

/**
 * Builds a REAL, executable swap transaction — and stops one step short of sending it.
 *
 * Requires DESK_WALLET_PUBKEY: a PUBLIC key only. This desk has no code path that reads,
 * stores, requests or accepts a private key or seed phrase, and none should ever be added.
 * The returned transaction is unsigned; signing and submitting happen in the CEO's own
 * wallet, by the CEO.
 */
export async function buildUnsignedSwap({ mint, usd, slippageBps = 150 }) {
  const pubkey = process.env.DESK_WALLET_PUBKEY;
  if (!pubkey) return { ok: false, error: "DESK_WALLET_PUBKEY not set (public key only)" };

  try {
    const amount = Math.round(usd * 1e6); // USDC has 6 decimals
    const qr = await fetch(
      `${JUP}/swap/v1/quote?inputMint=${MINTS.USDC}&outputMint=${mint}&amount=${amount}&slippageBps=${slippageBps}`
    );
    if (!qr.ok) return { ok: false, error: `quote HTTP ${qr.status}` };
    const quote = await qr.json();

    const sr = await fetch(`${JUP}/swap/v1/swap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quoteResponse: quote, userPublicKey: pubkey, wrapAndUnwrapSol: true }),
    });
    if (!sr.ok) return { ok: false, error: `swap-build HTTP ${sr.status}` };
    const built = await sr.json();
    if (!built.swapTransaction) return { ok: false, error: built.error || "no transaction returned" };

    return {
      ok: true,
      unsignedTransactionBase64: built.swapTransaction,
      signed: false,
      submitted: false,
      wallet: pubkey,
      expectedOut: quote.outAmount,
      priceImpactPct: quote.priceImpactPct != null ? Number(quote.priceImpactPct) * 100 : null,
      lastValidBlockHeight: built.lastValidBlockHeight,
      note: "UNSIGNED. This desk cannot and will not sign or submit it.",
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/**
 * THE ORDER SLIP — what actually comes out from under the CEO's door.
 * A human reads this, opens the GMGN link, and signs. Nothing else executes.
 */
export async function writeOrderSlip(cycle, { ev, ceo, pm, risk, ticket }) {
  const links = gmgn.links(ev.mint, ev.pair?.pairAddress);
  const size = ceo.order_size_usd ?? risk?.position_size_usd ?? 0;

  let tx = { ok: false, error: "not requested" };
  if (ceo.ruling === "APPROVE" && size > 0 && process.env.DESK_WALLET_PUBKEY) {
    emit("order:building", { mint: ev.mint, symbol: ev.symbol });
    tx = await buildUnsignedSwap({ mint: ev.mint, usd: size, slippageBps: ticket?.max_slippage_bps ?? 150 });
  }

  const dir = path.join(ROOT, "reports");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${cycle}__ORDER__${ev.symbol}__${ceo.ruling}.md`);

  const L = [];
  L.push(`# Order slip — ${ev.symbol} · ${ceo.ruling}`);
  L.push(`\n\`${ev.mint}\`\n`);
  L.push(`> **Unsigned. Nothing has been executed.** Claude Co cannot sign or send.`);
  L.push(`> To act on this, open the GMGN link below and place it yourself.\n`);
  L.push(`## The CEO's ruling\n`);
  L.push(`**${ceo.one_line}**\n`);
  L.push(`${ceo.reasoning}\n`);
  L.push(`| | |`);
  L.push(`|---|---|`);
  L.push(`| Ruling | **${ceo.ruling}** |`);
  L.push(`| Size | $${size}${ceo.size_change_reason ? ` _(changed: ${ceo.size_change_reason})_` : ""} |`);
  L.push(`| PM conviction | ${pm?.conviction ?? "—"}/100 |`);
  L.push(`| Stop | $${ticket?.stop_price ?? "—"} |`);
  L.push(`| Max slippage | ${ticket?.max_slippage_bps ?? "—"} bps |`);
  L.push(`| CEO confidence | ${ceo.confidence} |`);

  if (ceo.conditions?.length) L.push(`\n**Conditions**\n${ceo.conditions.map((c) => `- ${c}`).join("\n")}`);
  if (ceo.questions_for_the_desk?.length)
    L.push(`\n**Back to the desk**\n${ceo.questions_for_the_desk.map((q) => `- ${q}`).join("\n")}`);

  L.push(`\n## Place it\n`);
  L.push(`- **GMGN (buy):** ${links.gmgn}`);
  L.push(`- GMGN chart: ${links.gmgn_chart}`);
  L.push(`- DexScreener: ${links.dexscreener ?? "—"}`);
  L.push(`- Solscan: ${links.solscan}`);
  L.push(`\nGMGN is bot-protected, so this desk cannot reach it server-side and does not try.`);
  L.push(`Open the link in your own browser, where your wallet lives.`);

  if (tx.ok) {
    L.push(`\n## Prepared transaction (unsigned)\n`);
    L.push(`Built against Jupiter for wallet \`${tx.wallet}\`. Signed: **no**. Submitted: **no**.\n`);
    L.push(`| Field | Value |`);
    L.push(`|---|---|`);
    L.push(`| Expected out | ${tx.expectedOut} (raw units) |`);
    L.push(`| Price impact | ${tx.priceImpactPct?.toFixed(3) ?? "—"}% |`);
    L.push(`| Valid to block | ${tx.lastValidBlockHeight} |`);
    L.push(`\n<details><summary>Base64 transaction — paste into your own signer</summary>\n\n\`\`\`\n${tx.unsignedTransactionBase64}\n\`\`\`\n</details>`);
  } else if (ceo.ruling === "APPROVE") {
    L.push(`\n_No transaction was prepared: ${tx.error}._`);
  }

  L.push(`\n---\n_Claude Co · ${new Date().toISOString()} · research and order preparation only._`);
  fs.writeFileSync(file, L.join("\n"));

  const rel = path.relative(ROOT, file);
  emit("order:slip", { mint: ev.mint, symbol: ev.symbol, ruling: ceo.ruling, size, file: rel, gmgn: links.gmgn });
  return { file: rel, links, tx, size };
}
