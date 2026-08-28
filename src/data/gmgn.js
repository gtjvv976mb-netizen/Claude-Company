/**
 * GMGN handoff.
 *
 * GMGN sits behind Cloudflare bot protection: a server-side request from this desk is
 * answered with 403 even for a plain token page. That is deliberate on their side and
 * this desk does not attempt to work around it.
 *
 * So the handoff is a deep link. The CEO opens it in their own browser, where they are
 * already authenticated and where their own wallet signs. The desk supplies the research
 * and the exact order; the human supplies the signature. No key ever reaches this code.
 */
export const GMGN_BASE = "https://gmgn.ai";

export function tokenLink(mint) {
  return `${GMGN_BASE}/sol/token/${mint}`;
}

/** GMGN's trade view for a mint, which is where the CEO actually places the order. */
export function tradeLink(mint) {
  return `${GMGN_BASE}/sol/token/${mint}?tab=buy`;
}

export function links(mint, pairAddress) {
  return {
    gmgn: tradeLink(mint),
    gmgn_chart: tokenLink(mint),
    dexscreener: pairAddress ? `https://dexscreener.com/solana/${pairAddress}` : null,
    solscan: `https://solscan.io/token/${mint}`,
  };
}
