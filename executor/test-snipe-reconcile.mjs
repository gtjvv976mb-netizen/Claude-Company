/**
 * A POSITION THAT IS NOT UNSELLABLE BUT ALREADY GONE.
 *
 * 2026-09-17. The owner's lane kept a row for 5xXJ1Aqjw…pump for eight hours and failed
 * its exit once per tick, sixty times and counting. The coin had been SOLD at 12:17:42Z:
 * 0.193313 SOL came back against 0.201920 spent, the sale confirmed on chain, and the
 * wallet's balance of that mint was zero the whole time the lane was trying to sell it.
 * Nothing was at risk — the sell failed before anything was signed — but the row held an
 * open slot and its realised result was missing from the record.
 *
 * The retry rule it hit is right for what it was written for, and its comment says so:
 * "a position the lane could not sell is not a position the lane may forget." What it
 * could not distinguish is a sell that FAILED from a position that had already GONE.
 *
 * So the lane now asks the wallet, through a port, and this file pins the answer table —
 * because every wrong answer here is a different kind of bad:
 *
 *   · a definite ZERO closes the row (the loop ends, the slot comes back);
 *   · a NON-ZERO keeps it (the coin is really there and the sell really failed);
 *   · NO PORT, a THROW, a NULL and an unparseable amount all KEEP it. Not knowing must
 *     never close a position — that is the difference between reconciling a sale that
 *     happened and forgetting one that did not.
 *
 * And the row that does close carries NO realised number. The sale happened outside this
 * lane's sight, so "not read" is true where a zero would be a lie.
 *
 *   node test-snipe-reconcile.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
};

const lane = await import("./snipe-lane.mjs");
const { PUMPFUN_VENUE } = await import("./snipe-venue-pumpfun.mjs");
const { openSnipe, snipeList } = await import("./snipe-book.mjs");

const WALLET = "D7ppNxdmcoVtEHsHjV47D8q2nGdoUjhdgPpKYmX9gwps";
const MINT = "5xXJ1Aqjw2vbBxUTYkeruvnFxm69qmDz9LfeNWSupump";
const readers = ["primary", "secondary"].map((id) => ({
  id, async read() { return { slot: 1000, accounts: [null, null, null] }; },
}));
const control = () => ({ hardStop: false, pauseEntries: false });

/** An armed lane whose sell always fails, with the wallet answering however we say. */
function armedLane({ holdingsReader, sellError = new Error("simulation failed: nothing to sell") }) {
  const lines = [];
  const port = {
    wallet: WALLET,
    prepareBuy() { throw new Error("not in this test"); },
    async buy() { throw new Error("not in this test"); },
    async sell() { throw sellError; },
  };
  const cfg = lane.snipeLaneConfig({ SNIPE_LANE: "execute", SNIPE_MAX_SOL_PER_TRADE: "0.05",
    SNIPE_DAILY_SOL_CAP: "0.2", SNIPE_STOP_FRAC: "0.7" });
  const S = {};
  const built = lane.createSnipeLane({
    venue: PUMPFUN_VENUE, readers, control, state: S,
    cfg: { ...cfg, liveAck: lane.snipeArmSentence(WALLET, 0.05, 0.2), holdMaxMs: 1 },
    executor: port, log: (m) => lines.push(String(m)),
    ...(holdingsReader === undefined ? {} : { holdingsReader }),
  });
  /* An open position, filed the way a landed buy files one. Aged past holdMaxMs so the
     very next tick decides to sell — which is the moment this whole file is about. */
  openSnipe(S, {
    mint: MINT, venue: PUMPFUN_VENUE.id, openedAt: Date.now() - 60_000, entry: 1,
    sizeSol: 0.200308, feeSolPerLeg: 0.000015,
    qtyRaw: "8890325990118", entryInputLamports: "200293000", entryFeeLamports: "15000",
    costBasisLamports: "200308000",
    curve: { vBaseRaw: "1039482477559425", vQuoteRaw: "22894697634" },
    forward: [], samples: 0, marks: [], high: 1, signature: "oeAKmkg4yNidn8DH4zf5CvbS",
  });
  return { lane: built, S, lines };
}

const holdings = (qtyRaw) => ({ async read() { return { qtyRaw }; } });

console.log("\na definite zero closes the row — the loop ends");
{
  const { lane: l, S, lines } = armedLane({ holdingsReader: holdings("0") });
  ok("the position is open before the tick", snipeList(S).length === 1);
  const out = await l.tick();
  ok("the row is closed rather than latched", snipeList(S).length === 0,
    `${snipeList(S).length} open after the tick`);
  ok("...and the tick says it reconciled, not that it exited",
    out[0]?.action === "reconciled" && out[0]?.reconciled === true && out[0]?.closed === true,
    JSON.stringify(out[0] && { action: out[0].action, reconciled: out[0].reconciled }));
  const stats = l.stats();
  ok("it is counted as a reconcile, apart from the exit failures",
    stats.reconciled === 1,
    `reconciled ${stats.reconciled}, exitFailures ${stats.exitFailures}`);
  /* The failed sell IS still counted — it really did fail, and hiding that would be the
     same mistake in the other direction. */
  ok("...and the sell that failed is still counted as a failure", stats.exitFailures === 1,
    `exitFailures ${stats.exitFailures}`);
  /* WHAT THE OPERATOR ACTUALLY SEES. A silent reconcile is a position that vanished
     from the book with no account of itself, which is its own kind of wrong. */
  const said = lines.find((m) => /RECONCILED/.test(m)) || "";
  ok("it says out loud that it reconciled, and why",
    /RECONCILED/.test(said) && /wallet holds none of it/.test(said),
    said.slice(0, 110));
  ok("...and says plainly that the result is not known here, rather than implying zero",
    /realised result is not read here/.test(said));
  const row = l.rows().find((r) => r.mint === MINT);
  ok("NO realised figure is invented for a sale this lane never saw",
    (row?.realizedLamports ?? null) === null && (row?.quoteOutRaw ?? null) === null,
    `realizedLamports ${JSON.stringify(row?.realizedLamports ?? null)}`);
  ok("...and no exit signature is claimed either",
    (row?.exitSignature ?? null) === null);
}

console.log("\nevery answer that is not a definite zero KEEPS the position");
for (const [label, reader] of [
  ["a non-zero balance — the coin is really there", holdings("8890325990118")],
  ["one single raw unit", holdings("1")],
  ["a null balance — unknown, not zero", holdings(null)],
  ["an amount that will not parse", holdings("not-a-number")],
  ["a reader that throws", { async read() { throw new Error("rpc down"); } }],
  ["a port that is not a reader at all", { nope: true }],
  ["no port at all (observe installs, and every lane before this change)", undefined],
]) {
  const { lane: l, S } = armedLane({ holdingsReader: reader });
  const out = await l.tick();
  ok(`${label} → kept and latched`,
    snipeList(S).length === 1 && out[0]?.closed === false && out[0]?.latched === true &&
    l.stats().reconciled === 0,
    `open ${snipeList(S).length}, closed ${out[0]?.closed}, reconciled ${l.stats().reconciled}`);
}

console.log("\nthe reader is a PORT, and this lane still reaches no network of its own");
{
  const src = fs.readFileSync(new URL("./snipe-lane.mjs", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("async function walletHoldsNothing"),
    src.indexOf("async function exitForReal"));
  ok("walletHoldsNothing is present", fn.length > 300, `${fn.length} chars`);
  for (const forbidden of ["new Connection", "fetch(", "getParsedTokenAccounts", "@solana/web3.js"])
    ok(`it never calls ${forbidden} itself`, !fn.includes(forbidden));
  ok("it returns false on every path but the certain one",
    (fn.match(/return false;/g) || []).length >= 4 && /BigInt\(text\) === 0n/.test(fn),
    `${(fn.match(/return false;/g) || []).length} fail-closed returns`);
  /* THE WIRING. A port nothing passes is a fix nothing runs — the exact way the
     already_holding gate was defeated for weeks by an unpassed `state`. */
  const poller = fs.readFileSync(new URL("./poller.mjs", import.meta.url), "utf8");
  ok("the poller actually passes a holdingsReader to the lane",
    /holdingsReader: \{/.test(poller) && /createSnipeLane\(\{/.test(poller));
  ok("...only on a live install, where a signing wallet exists",
    /\.\.\.\(snipeExecutor \? \{ holdingsReader/.test(poller));
  ok("...and it reads the SIGNING wallet's own accounts for that mint",
    /getParsedTokenAccountsByOwner\(kp\.publicKey, \{ mint:/.test(poller));
  ok("...treating an unparseable amount as unknown rather than as none",
    /if \(!\/\^\\d\+\$\/\.test\(String\(amount \?\? ""\)\)\) return \{ qtyRaw: null \};/.test(poller));
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} test-snipe-reconcile  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
