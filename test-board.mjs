/**
 * THE BOARD — cap band x coin type, and paid attention spread across it.
 *
 * The desk used to take the top N by score, which meant a cycle could spend every
 * workup inside one drawer and learn nothing about the rest of the market. Worse, an
 * empty drawer was invisible: "no legitimate coin under $100k this hour" is a finding,
 * and it looked exactly like not having looked.
 */
import { CAP_BANDS, COIN_TYPES, capBandOf, coinTypeOf, cellOf, buildBoard, selectAcrossBoard }
  from "./src/categories.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const coin = (mcap, name = "Dog", sym = "DOG", score = 50) => ({
  mint: `${sym}${mcap}`, score,
  pair: { marketCap: mcap, baseName: name, baseSymbol: sym, websites: [] },
});

console.log("\nCAP BANDS — the owner's five, exactly");
for (const [mcap, want] of [[50_000, "micro"], [250_000, "low"], [750_000, "medium"],
                            [5_000_000, "high"], [15_000_000, "very_high"]])
  ok(`$${mcap.toLocaleString()} -> ${want}`, capBandOf(coin(mcap)) === want, capBandOf(coin(mcap)));
ok("under $10k is off the board", capBandOf(coin(5_000)) === null, "too little coin to trade");
ok("over $20m is off the board", capBandOf(coin(50_000_000)) === null, "somebody else's business");
ok("an UNREADABLE cap is never assigned a band",
  capBandOf({ pair: { marketCap: null, fdv: null } }) === null,
  "an unknown number must not be given a drawer it may not belong in");

console.log("\nCOIN TYPE — read from what the project says it is");
ok("a dog picture is a memecoin", coinTypeOf(coin(1e5, "Doge Wif Hat", "WIF")) === "memecoin");
ok("a game token is web3_gaming", coinTypeOf(coin(1e5, "Battle Arena Quest", "ARENA")) === "web3_gaming");
ok("a protocol token is utility", coinTypeOf(coin(1e5, "Lending Protocol", "LEND")) === "utility");
ok("the DEFAULT is memecoin, not utility",
  coinTypeOf(coin(1e5, "Zorp", "ZORP")) === "memecoin",
  "on this chain that is the base rate; claiming otherwise needs evidence");

console.log("\nTHE BOARD SPREADS PAID ATTENTION ACROSS CELLS");
// A market where one drawer is stuffed and the others hold one coin each. The old
// top-N would have spent every slot inside the stuffed drawer.
const market = [
  ...Array.from({ length: 10 }, (_, i) => coin(200_000, "Meme" + i, "M" + i, 90 - i)),  // low/memecoin
  coin(50_000, "Micro Dog", "MD", 40),                                                  // micro/memecoin
  coin(750_000, "Mid Quest Game", "MQ", 35),                                            // medium/web3_gaming
  coin(5_000_000, "Big Protocol", "BP", 30),                                            // high/utility
];
const board = buildBoard(market, { perCell: 5 });
ok("four cells are filled", board.filled === 4, `${board.filled} of ${board.possible} possible`);
ok("the stuffed cell is capped at perCell",
  board.cells.find((c) => c.key === "low/memecoin").coins.length === 5,
  "10 seen, 5 shortlisted");
ok("...and still records how many it SAW",
  board.cells.find((c) => c.key === "low/memecoin").total === 10);

const picked = selectAcrossBoard(board, 4);
const cells = new Set(picked.map((p) => p.cellKey));
ok("four workups touch FOUR different cells", cells.size === 4, [...cells].join(", "));
ok("the top-scored coin is still taken first", picked[0].pair.baseSymbol === "M0",
  "best cell first, then one from each");

const deep = selectAcrossBoard(board, 8);
ok("only once every cell is sampled does it double up",
  deep.slice(0, 4).every((p, i, a) => a.filter((x) => x.cellKey === p.cellKey).length === 1),
  "first pass is one per cell");
ok("and a deeper budget does come back for second-bests", deep.length === 8, `${deep.length} picked`);

console.log("\nAN EMPTY CELL IS A FINDING, NOT A GAP");
ok("cells the market did not fill are visibly absent",
  board.filled < board.possible,
  `${board.possible - board.filled} cells had nothing legitimate in them this sweep`);

console.log("\nTHE FREE SCREEN STILL GATES WHAT REACHES THE BOARD");
const strict = buildBoard(market, { perCell: 5, viable: (c) => c.pair.marketCap >= 500_000 });
ok("a coin the screen would refuse never gets shortlisted",
  strict.cells.every((c) => c.coins.every((x) => x.pair.marketCap >= 500_000)),
  "the board never shortlists what the desk was always going to refuse");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
