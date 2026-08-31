/**
 * THE BOARD — every coin the desk sees, sorted into a grid it can be held to.
 *
 * The desk used to hold one shortlist and publish its single best. That works, and it
 * hides something: a "best" chosen from whatever the sweep happened to surface is not
 * the best of the MARKET, it is the best of an accident. Two of three candidates being
 * launch farms told us nothing about whether a good $400k coin existed that hour,
 * because nobody looked in that drawer.
 *
 * So the market is divided twice — by SIZE, because a $40k coin and a $15m coin are
 * different trades with different odds and different reasons to be wrong, and by WHAT
 * THE COIN IS, because a game token with a build behind it and a dog picture are not
 * the same asset even at the same market cap.
 *
 * The grid is the point. Filling every cell forces the desk to look where it would
 * otherwise not, and an empty cell is itself information: "nothing legitimate under
 * $100k this hour" is a finding, not a gap.
 *
 * Nothing here costs money. Every judgement below comes from pair data already in
 * hand — the expensive seats are spent only on what this narrows down to.
 */
import { cfg } from "./config.js";

/** Market-cap bands, as the owner specified them. */
export const CAP_BANDS = {
  micro:     { lo: 10_000,     hi: 100_000,    label: "micro",     note: "$10k-$100k — sharpest moves, sharpest rugs" },
  low:       { lo: 100_000,    hi: 500_000,    label: "low",       note: "$100k-$500k — room to re-rate, thin book" },
  medium:    { lo: 500_000,    hi: 1_000_000,  label: "medium",    note: "$500k-$1m — a tape worth reading" },
  high:      { lo: 1_000_000,  hi: 10_000_000, label: "high",      note: "$1m-$10m — needs real money to move" },
  very_high: { lo: 10_000_000, hi: 20_000_000, label: "very high", note: "$10m-$20m — slow, but survivable" },
};

/** What KIND of thing this is. Three, deliberately — more would be false precision. */
export const COIN_TYPES = {
  memecoin:    "a true memecoin — the story IS the asset, no product is claimed",
  web3_gaming: "a game or gaming ecosystem token, with something playable claimed",
  utility:     "claims a working product or service the token is used for",
};

const GAMING = /\b(game|gaming|gamefi|play|player|quest|arena|battle|guild|metaverse|nft game|p2e|rpg|mmo|esport|studio)\b/i;
const UTILITY = /\b(protocol|swap|dex|lend|borrow|stake|staking|yield|vault|bridge|oracle|infra|network|node|validator|ai agent|api|sdk|launchpad|wallet|payment|rwa|index)\b/i;

/**
 * Which band does this coin sit in? Null when the cap is unreadable — an unknown
 * number must never be assigned a drawer it might not belong in, and the rest of the
 * desk already follows that rule everywhere else.
 */
export function capBandOf(coin) {
  const mc = coin?.pair?.marketCap ?? coin?.pair?.fdv ?? null;
  if (mc == null || !(mc > 0)) return null;
  for (const [key, b] of Object.entries(CAP_BANDS))
    if (mc >= b.lo && mc < b.hi) return key;
  return null;                                    // outside every band the desk trades
}

/**
 * What kind of coin is this?
 *
 * Read from the name, symbol and the project's own links — which is all a free sweep
 * carries. It is a first pass, not a verdict: the narrative seat reads the actual site
 * and X account later and can contradict it. Defaults to memecoin, because on this
 * chain that is the base rate and claiming otherwise needs evidence.
 */
export function coinTypeOf(coin) {
  const p = coin?.pair ?? {};
  const text = `${p.baseName ?? ""} ${p.baseSymbol ?? ""} ${(p.websites ?? []).map((w) => w?.url ?? w).join(" ")}`;
  if (GAMING.test(text)) return "web3_gaming";
  if (UTILITY.test(text)) return "utility";
  return "memecoin";
}

/** The grid cell a coin belongs to, or null if it is outside the board entirely. */
export function cellOf(coin) {
  const band = capBandOf(coin);
  if (!band) return null;
  return { band, type: coinTypeOf(coin), key: `${band}/${coinTypeOf(coin)}` };
}

/**
 * Build the board: every cell, with its best candidates ranked inside it.
 *
 * `perCell` is how many the desk shortlists per cell — the owner's "at least 5 per
 * category". They are CANDIDATES, not calls: nothing here has been researched yet, and
 * putting a coin on the board costs nothing.
 *
 * `viable` is the free-screen filter passed in by the caller, so the board never
 * shortlists a coin the desk was always going to refuse on arrival.
 */
export function buildBoard(scored, { perCell = 5, viable = () => true } = {}) {
  const cells = new Map();
  let offBoard = 0;
  for (const c of scored) {
    const cell = cellOf(c);
    if (!cell) { offBoard++; continue; }
    if (!viable(c)) continue;
    if (!cells.has(cell.key)) cells.set(cell.key, { ...cell, coins: [] });
    cells.get(cell.key).coins.push(c);
  }
  for (const cell of cells.values()) {
    cell.coins.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    cell.total = cell.coins.length;
    cell.coins = cell.coins.slice(0, perCell);
  }
  return {
    cells: [...cells.values()].sort((a, b) => (b.coins[0]?.score ?? 0) - (a.coins[0]?.score ?? 0)),
    offBoard,
    filled: cells.size,
    possible: Object.keys(CAP_BANDS).length * Object.keys(COIN_TYPES).length,
  };
}

/**
 * Pick who gets the expensive seats.
 *
 * ONE PER CELL FIRST, best cell first — so the desk's paid attention is spread across
 * the board before it doubles up anywhere. A cycle that spends all eight workups inside
 * one drawer learns a great deal about that drawer and nothing about the market, which
 * is exactly the failure the board exists to prevent. Only once every cell has been
 * sampled does it come back for second-bests.
 */
export function selectAcrossBoard(board, budget) {
  const picked = [];
  for (let depth = 0; picked.length < budget; depth++) {
    let addedAny = false;
    for (const cell of board.cells) {
      if (picked.length >= budget) break;
      const c = cell.coins[depth];
      if (!c) continue;
      picked.push({ ...c, cellKey: cell.key, band: cell.band, coinType: cell.type });
      addedAny = true;
    }
    if (!addedAny) break;                         // the board is exhausted
  }
  return picked;
}
