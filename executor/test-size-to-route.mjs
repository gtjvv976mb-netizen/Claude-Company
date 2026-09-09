/**
 * SIZE TO THE ROUTE — the cost gates decide HOW MUCH, not WHETHER.
 *
 * Three entry gates are functions of the AMOUNT, not of the coin: the round-trip loss cap
 * (12%), the entry price-impact cap (5%) the order envelope applies at signing, and the
 * executable-cost stop floor. Every one of them used to be a binary refusal, and the
 * refusal landed on the acknowledge branch of the poll loop — the published call was
 * consumed permanently, un-retried. A 0.4 SOL clip that costs 14% round trip through a
 * thin pool is not an unsafe coin; it is too big an order for that pool.
 *
 * So the ladder re-quotes at half (at most 3 times) and binds the trade to the largest
 * amount that clears all three at once. This probe drives the REAL
 * JupiterV2Executor.preflightEntryProbe against a local HTTP stub whose pool has a
 * measured cost curve, the REAL sizeEntryToRoute ladder, and the REAL
 * minViableSolPerTrade floor from strategy.mjs — so the numbers printed below are the
 * numbers the poller would bind.
 *
 * The load-bearing assertions are the two that could hide a defect:
 *   · the stop floor is re-evaluated AT THE SIZED AMOUNT. Halving cures round-trip and
 *     impact but makes the fixed network fee a BIGGER share of the trade, so a rung that
 *     clears both caps can still fail the stop floor. A ladder that checked the floor once
 *     at the desk's clip would buy a position it had just proved unprofitable.
 *   · a curve that is too expensive at every fundable size is still REFUSED, with the
 *     wallet fact named: below the minimum viable size a position is not a smaller bet,
 *     it is the same fixed fees against less upside.
 */
import http from "node:http";
import { JupiterV2Executor } from "./jupiter.mjs";
import { DEFAULTS, minViableSolPerTrade } from "./strategy.mjs";
import { MAX_ROUTE_HALVINGS, sizeEntryToRoute } from "./entry-sizing.mjs";
import fs from "node:fs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const WSOL = "So11111111111111111111111111111111111111112";
const MINT = "RoUtEsIzInGpRoBeMiNt1111111111111111111111";
const LAMPORTS = 1_000_000_000;
const TOKENS_PER_SOL = 1_000;            // the stub pool's nominal rate; it cancels out
const EXPECTED_FEE_LAMPORTS = 500_000;   // the COST MODEL, never the refusal gate
const SLIPPAGE_BPS = 300;

/* THE POOL. `sol -> { rt, impact }` is the whole fixture: the cost a round trip of that
   size pays through this pool, and the price impact its forward leg prints. The default
   curve is the plan's measured shape — 14%/6%/3% round trip against 7%/4%/2% impact —
   so 0.4 SOL breaches both caps, 0.2 SOL clears both, and 0.1 SOL is cheaper still. */
const THIN_POOL = [
  { sol: 0.4, rt: 14, impact: 7 },
  { sol: 0.2, rt: 6, impact: 4 },
  { sol: 0.1, rt: 3, impact: 2 },
  { sol: 0.05, rt: 1.5, impact: 1 },
];
const DEAD_POOL = THIN_POOL.map((r) => ({ ...r, rt: 20, impact: 9 }));
const DEEP_POOL = THIN_POOL.map((r) => ({ ...r, rt: 1, impact: 0.4 }));

let pool = THIN_POOL;
let quoteCalls = 0;
const rowFor = (sol) => pool.reduce((best, row) =>
  Math.abs(row.sol - sol) < Math.abs(best.sol - sol) ? row : best);

const stub = http.createServer((req, res) => {
  quoteCalls++;
  const params = new URL(req.url, "http://127.0.0.1").searchParams;
  const inputMint = params.get("inputMint");
  const outputMint = params.get("outputMint");
  const inAmount = Number(params.get("amount"));
  // Forward leg: lamports in, tokens out. Reverse leg: tokens in, lamports out, short by
  // the pool's round-trip cost for THIS size.
  const sol = inputMint === WSOL ? inAmount / LAMPORTS : inAmount / TOKENS_PER_SOL / LAMPORTS;
  const row = rowFor(sol);
  const outAmount = inputMint === WSOL
    ? String(Math.floor(inAmount * TOKENS_PER_SOL))
    : String(Math.floor((inAmount / TOKENS_PER_SOL) * (1 - row.rt / 100)));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ inputMint, outputMint, inAmount: String(inAmount), outAmount,
    priceImpact: row.impact }));
});
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
const stubBase = `http://127.0.0.1:${stub.address().port}`;

const jupiter = new JupiterV2Executor({
  connection: {}, keypair: { publicKey: { toBase58: () => "StUbWaLlEt" } },
  // Nothing in the ladder touches the journal or a key; a Proxy that throws proves it.
  journal: new Proxy({}, { get() { throw new Error("route sizing touched the journal"); } }),
  apiKey: "stub-key",
  fetchFn: async (url, init) => {
    const target = new URL(String(url));
    return fetch(`${stubBase}${target.pathname}${target.search}`, init);
  },
  config: { maxEntryRoundTripLossPct: 12, maxPriceImpactPct: 5,
    expectedNetworkFeeLamports: EXPECTED_FEE_LAMPORTS, slippageBps: SLIPPAGE_BPS },
});

/* The poller's own minSizeFor, reproduced: strategy.mjs's floor charged at the friction
   the route just measured, exactly as poller.mjs onEntry builds it. */
const minSizeFor = (cfg, stopRatio) => (conservativeLossPct) =>
  minViableSolPerTrade(cfg, Math.min(1,
    Math.max(1e-9, 1 - stopRatio) + Math.max(0, conservativeLossPct) / 100));

const perCall = (over = {}) => ({ ...DEFAULTS, fixedSol: 0.4, maxSolPerTrade: 0.4,
  networkFeeReserveSol: EXPECTED_FEE_LAMPORTS / LAMPORTS, ...over });

async function ladder({ label, curve, stopRatio, sol = 0.4, cfg = perCall() }) {
  pool = curve;
  quoteCalls = 0;
  const result = await sizeEntryToRoute({
    probe: (amountRaw) => jupiter.preflightEntryProbe(WSOL, MINT, amountRaw),
    sol, lamportsPerSol: LAMPORTS, stopRatio,
    expectedNetworkFeeLamports: EXPECTED_FEE_LAMPORTS, slippageBps: SLIPPAGE_BPS,
    minSizeFor: minSizeFor(cfg, stopRatio),
  });
  console.log(`\n${label}  (stop at ${(stopRatio * 100).toFixed(0)}% of entry, cap 12% round trip / 5% impact)`);
  for (const a of result.attempts)
    console.log(`   ${String(a.sol.toFixed(4)).padStart(7)} SOL  round trip ${a.lossPct.toFixed(2).padStart(5)}%  ` +
      `impact ${a.impactPct.toFixed(2).padStart(5)}%  conservative return ${(a.conservativeReturnRatio * 100).toFixed(2)}%  ` +
      `min viable ${a.minSize.toFixed(4)} SOL  ->  ${a.refusal ? a.refusal.slice(0, 62) : "CLEARS ALL THREE"}`);
  console.log(`   verdict: ${result.ok ? `BUY ${result.sol.toFixed(4)} SOL` : "SKIP"}  ` +
    `(${quoteCalls} stub quotes = ${quoteCalls / 2} re-quoted amounts)`);
  return result;
}

console.log("\nA COST-SHAPED REFUSAL BECOMES A SMALLER FILL");
{
  const r = await ladder({ label: "thin pool, 15% stop", curve: THIN_POOL, stopRatio: 0.85 });
  ok("the 0.4 SOL clip is not bought", r.attempts[0].sol === 0.4 && r.attempts[0].refusal != null,
    `0.4 SOL: round trip ${r.attempts[0].lossPct.toFixed(2)}%, impact ${r.attempts[0].impactPct.toFixed(2)}%`);
  ok("the entry is sized to 0.2 SOL instead", r.ok === true && Math.abs(r.sol - 0.2) < 1e-12,
    r.ok ? `${r.sol.toFixed(4)} SOL` : r.refusal);
  ok("...and says it was sized down by the route",
    r.sizedDown === true && /sized down by the route/.test(r.reason || ""), r.reason);
  ok("the reason carries the numbers per halving",
    /0\.4000 SOL \(round trip 14\.00%, impact 7\.00%/.test(r.reason || "") &&
    /0\.2000 SOL \(round trip 6\.00%, impact 4\.00%/.test(r.reason || ""), r.reason);
  ok("each rung is a FRESH pair of quotes, not the first one reused",
    quoteCalls === r.attempts.length * 2, `${quoteCalls} quotes over ${r.attempts.length} rungs`);
  ok("the bound amount clears the round-trip cap", r.preflight.lossPct <= 12,
    `${r.preflight.lossPct.toFixed(2)}% <= 12%`);
  ok("the bound amount clears the entry impact cap", r.preflight.impactPct <= 5,
    `${r.preflight.impactPct.toFixed(2)}% <= 5%`);
  ok("the bound amount clears the stop floor", r.cost.conservativeReturnRatio > 0.85,
    `${(r.cost.conservativeReturnRatio * 100).toFixed(2)}% > 85.00%`);
}

console.log("\nTHE STOP FLOOR IS RE-EVALUATED AT THE SIZED AMOUNT");
{
  /* Halving cures the two route caps and WORSENS the fee share: at 0.2 SOL the two fixed
     500k-lamport fees are 0.50% of the trade, at 0.1 SOL they are 1.00%. So a rung can
     clear both caps and still be at/below the authored stop. A ladder that judged the
     floor once, at the desk's clip, would bind 0.2 SOL here — a trade it had just proved
     unprofitable. It must keep going. */
  const r = await ladder({ label: "thin pool, 12% stop", curve: THIN_POOL, stopRatio: 0.88 });
  const rung = r.attempts[1];
  ok("the 0.2 SOL rung is inside BOTH route caps", rung.lossPct <= 12 && rung.impactPct <= 5,
    `round trip ${rung.lossPct.toFixed(2)}%, impact ${rung.impactPct.toFixed(2)}%`);
  ok("...and is still refused, by the stop floor alone",
    /at\/below the authored stop/.test(rung.refusal || ""),
    `conservative return ${(rung.conservativeReturnRatio * 100).toFixed(4)}% vs stop 88.00%`);
  ok("the refusal names which term dominated", /dominant term: the measured round trip/.test(rung.refusal || ""),
    (rung.refusal || "").slice(0, 96));
  ok("so the ladder keeps halving and binds 0.1 SOL",
    r.ok === true && Math.abs(r.sol - 0.1) < 1e-12, r.ok ? `${r.sol.toFixed(4)} SOL` : r.refusal);
  ok("the fee share really did rise as the trade shrank",
    Math.abs(r.cost.worstFeeRatio - 0.01) < 1e-12,
    `0.2 SOL: ${(2 * EXPECTED_FEE_LAMPORTS / 0.2e9 * 100).toFixed(2)}% of the trade  ->  ` +
    `0.1 SOL: ${(r.cost.worstFeeRatio * 100).toFixed(2)}%`);
}

console.log("\nA CURVE TOO EXPENSIVE AT EVERY FUNDABLE SIZE IS STILL REFUSED");
{
  /* The wallet fact. minSolPerTrade 0.15 stands in for an operator whose floor is well
     above the fee floor; the ladder halves 0.4 -> 0.2, and stops there because 0.1 is
     under that minimum. Below it a position is not a smaller bet — it is the same fixed
     network fees against less upside — so this refusal is a money fact, not a routing
     one, and no re-quote can wish it away. */
  const cfg = perCall({ minSolPerTrade: 0.15 });
  const r = await ladder({ label: "dead pool, 0.15 SOL operator floor", curve: DEAD_POOL,
    stopRatio: 0.85, cfg });
  ok("no size is bought", r.ok === false, r.ok ? `${r.sol} SOL` : "SKIP");
  ok("it halved once and then hit the wallet floor", r.attempts.length === 2,
    r.attempts.map((a) => a.sol.toFixed(4)).join(" -> "));
  ok("the refusal names the minimum viable position, not the coin",
    /is under the 0\.1500 SOL minimum viable position/.test(r.refusal || "") &&
    /no fundable size clears the caps/.test(r.refusal || ""), r.refusal);
  ok("the floor it stopped at is strategy.mjs's own",
    Math.abs(r.attempts[1].minSize - minViableSolPerTrade(cfg,
      Math.min(1, 0.15 + r.attempts[1].conservativeLossPct / 100))) < 1e-12,
    `${r.attempts[1].minSize.toFixed(4)} SOL`);
}

console.log("\nTHE LADDER IS BOUNDED, AND DOES NOT SHRINK A TRADE THAT DOES NOT NEED IT");
{
  const bounded = await ladder({ label: "dead pool, ordinary 0.005 SOL floor",
    curve: DEAD_POOL, stopRatio: 0.85 });
  ok("it stops after the declared number of halvings",
    bounded.ok === false && bounded.attempts.length === MAX_ROUTE_HALVINGS + 1,
    `${bounded.attempts.length} rungs for MAX_ROUTE_HALVINGS ${MAX_ROUTE_HALVINGS}`);
  ok("...and says so rather than blaming the wallet",
    new RegExp(`${MAX_ROUTE_HALVINGS} halvings did not bring it inside the caps`).test(bounded.refusal || ""),
    (bounded.refusal || "").slice(-72));
  ok("the worst case is one quote pair per rung",
    quoteCalls === (MAX_ROUTE_HALVINGS + 1) * 2, `${quoteCalls} stub quotes`);

  const deep = await ladder({ label: "deep pool, 15% stop", curve: DEEP_POOL, stopRatio: 0.85 });
  ok("a route that clears the caps at the full clip is NOT sized down",
    deep.ok === true && Math.abs(deep.sol - 0.4) < 1e-12 && deep.sizedDown === false &&
    deep.reason === null, `${deep.sol.toFixed(4)} SOL, one rung, reason ${deep.reason}`);
  ok("and it cost exactly one quote pair", quoteCalls === 2, `${quoteCalls} stub quotes`);
}

console.log("\nTHE CAPS THEMSELVES DID NOT MOVE, AND THE DESK IS NOWHERE IN THE LADDER");
{
  pool = THIN_POOL;
  /* preflightEntry — the throwing gate every other caller uses — is unchanged: 14% at the
     full clip still raises, in the same words. Only the new probe reports instead. */
  let raised = null;
  try { await jupiter.preflightEntry(WSOL, MINT, String(0.4 * LAMPORTS)); }
  catch (error) { raised = error.message; }
  ok("preflightEntry still THROWS over the round-trip cap", /exceeds cap 12%/.test(raised || ""), raised);

  const source = fs.readFileSync(new URL("./entry-sizing.mjs", import.meta.url), "utf8");
  for (const field of ["size_sol", "fixed_sol", "conviction"])
    ok(`the ladder never reads the desk's ${field}`, !new RegExp(`\\b${field}\\b`).test(source));
  const poller = fs.readFileSync(new URL("./poller.mjs", import.meta.url), "utf8");
  ok("poller.mjs sizes the entry through the shared ladder",
    /sizeEntryToRoute\(\{/.test(poller) &&
    /probe: \(amountRaw\) => jupiter\.preflightEntryProbe\(WSOL, ev\.mint, amountRaw\)/.test(poller),
    (poller.match(/.*preflightEntryProbe.*/) || ["none"])[0].trim());
  ok("the starting amount is the bot's own plan, not a feed field",
    /sol: plan\.sol, lamportsPerSol: LAMPORTS/.test(poller),
    (poller.match(/.*sol: plan\.sol.*/) || ["none"])[0].trim());
  ok("the route ceiling is applied through maxSolPerTrade, and fixedSol stays the bot's",
    /maxSolPerTrade: Math\.min\(perCall\.maxSolPerTrade, sizing\.sol\)/.test(poller) &&
    /fixedSol: CFG\.fixedSol/.test(poller));
}

stub.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
