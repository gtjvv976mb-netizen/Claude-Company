/**
 * THE FEE LANE, PINNED — and the thing pinned hardest is a number this module refuses to
 * produce.
 *
 * bagworkagent.fun's `pnlSol` adds claimed creator fees to trading P&L. That is how a bot that
 * loses -0.077 SOL across 362 trades displays +15.6 SOL, and it is not a display bug: it is
 * the mechanism by which a losing strategy survives contact with its owner. Nobody switches
 * off a bot showing +15.6.
 *
 * So the last section of this file asserts that `feeSummary()` has no `total`, no `pnl` and no
 * `net`, that fee rows live in their own book, and that nothing in the module sums the two. If
 * a future edit adds that field, this suite fails — which is the only way a rule like that
 * survives a year of edits.
 *
 * Everything above it is the arithmetic that keeps the lane from spending money to earn
 * nothing: an unreadable vault is not an empty one, rent that cannot move is not revenue, and
 * a claim that does not clear its own cost is not made.
 *
 *   node test-fee-lane.mjs
 */
import fs from "node:fs";
import {
  FEE_LANE_VERSION, FEE_LANE_DEFAULTS, FEE_RECORD_KINDS, SKIP_CLAUSES,
  SYSTEM_RENT_EXEMPT_LAMPORTS, FeeLaneError,
  feeClaimDecision, feeArmSentence, createFeeLane, feeSummary,
} from "./fee-lane.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
};
const threw = (fn) => { try { fn(); return null; } catch (e) { return e; } };
const arose = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const SOL = 1_000_000_000;
const CREATOR = "Cr8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WALLET = "Wa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const vault = (over = {}) => ({ creator: CREATOR, readable: true, curveLamports: 0, ammLamports: 0, ...over });
const decide = (claimable, cfg = {}, hardStop = false) => feeClaimDecision({ claimable, cfg, hardStop });

console.log("\nunknown is not zero, and rent is not revenue");
{
  const unreadable = decide(vault({ readable: false, curveLamports: null, ammLamports: null }));
  ok("an unreadable vault does NOT claim", unreadable.claim === false);
  ok("...and says unreadable, not empty", unreadable.clause === "unreadable");
  ok("...and reports no gross, rather than a gross of zero", unreadable.grossLamports === null);
  ok("...and the message says why it will not spend a signature on a guess",
    /not the same fact as an empty vault/.test(unreadable.message));

  /* The opposite mistake: a vault that genuinely holds nothing must produce a MEASURED zero
     with the arithmetic attached, not an "unknown". */
  const empty = decide(vault());
  ok("a genuinely empty vault reports a measured zero gross", empty.claim === false && empty.grossLamports === 0);
  ok("...and its net is NEGATIVE, because a claim would still cost a signature",
    empty.netLamports === -FEE_LANE_DEFAULTS.signatureFeeLamports, String(empty.netLamports));

  /* RENT THAT CANNOT MOVE IS NOT CLAIMABLE. A curve vault sitting at exactly the rent-exempt
     minimum has nothing to give, and a lane that read its balance as revenue would claim the
     same few thousand lamports forever and book each pass as income. */
  const rentOnly = decide(vault({ curveLamports: SYSTEM_RENT_EXEMPT_LAMPORTS }));
  ok("a curve vault holding only its rent has nothing claimable", rentOnly.curveClaimableLamports === 0);
  ok("...so it does not claim", rentOnly.claim === false && rentOnly.clause === "below_floor");
  ok("the rent reserve is subtracted from the curve side only",
    decide(vault({ curveLamports: SYSTEM_RENT_EXEMPT_LAMPORTS + 10_000_000, ammLamports: 5_000_000 }), { live: true })
      .grossLamports === 15_000_000);
  /* The pump-amm side is a token account the claim CLOSES, so its rent returns in the same
     transaction and must not be deducted twice. */
  ok("...and never from the pump-amm side, whose rent comes back when the claim closes it",
    decide(vault({ ammLamports: 9_000_000 }), { live: true }).grossLamports === 9_000_000);
  ok("the rent reserve is a config key an operator who measured it can correct",
    decide(vault({ curveLamports: 10_000_000 }), { live: true, rentReserveLamports: 0 }).grossLamports === 10_000_000);
  /* THE NUMBER WAS MEASURED, NOT REMEMBERED. getMinimumBalanceForRentExemption(0) on mainnet,
     2026-09-26, answered 650240; this constant was written as 890880 from memory first and the
     chain was asked before it shipped. The error would have been in the safe direction — too
     high leaves a little behind — but a constant that silently under-claims forever is a
     revenue line quietly missing 0.00024 SOL per claim. */
  ok("and it defaults to the rent-exempt minimum MEASURED on mainnet, not one from memory",
    FEE_LANE_DEFAULTS.rentReserveLamports === SYSTEM_RENT_EXEMPT_LAMPORTS && SYSTEM_RENT_EXEMPT_LAMPORTS === 650_240);
}

console.log("\na claim that cannot pay for itself is not made");
{
  const tiny = decide(vault({ curveLamports: SYSTEM_RENT_EXEMPT_LAMPORTS + 20_000 }));
  ok("20,000 lamports is over the fee but under the floor", tiny.claim === false && tiny.clause === "below_floor");
  ok("the refusal shows the whole arithmetic: gross, rent, fees, net and floor",
    /0\.000020 SOL is claimable/.test(tiny.message) && /of rent that cannot move/.test(tiny.message)
    && /net of/.test(tiny.message) && /under the 0\.002000 floor/.test(tiny.message), tiny.message.slice(0, 120));
  ok("...and it says fees keep accruing, so skipping costs nothing",
    /worth exactly as much next pass/.test(tiny.message));
  ok("the floor is judged NET of cost, not gross",
    decide(vault({ curveLamports: SYSTEM_RENT_EXEMPT_LAMPORTS + 2_000_000 }), { live: true, signatureFeeLamports: 5_000 }).claim === false
    && decide(vault({ curveLamports: SYSTEM_RENT_EXEMPT_LAMPORTS + 2_005_000 }), { live: true, signatureFeeLamports: 5_000 }).claim === true);
  ok("a priority fee raises the bar the claim has to clear",
    decide(vault({ curveLamports: SYSTEM_RENT_EXEMPT_LAMPORTS + 2_005_000 }),
      { live: true, priorityFeeLamports: 1_000_000 }).claim === false);
  ok("the default floor is 0.002 SOL — roughly twenty times a claim's own fees",
    FEE_LANE_DEFAULTS.minNetLamports === 2_000_000);
}

console.log("\nwhat a live pass includes, and what stops one");
{
  const rich = vault({ curveLamports: SYSTEM_RENT_EXEMPT_LAMPORTS + 50_000_000, ammLamports: 10_000_000 });
  const live = decide(rich, { live: true });
  ok("a rich pair of vaults claims", live.claim === true && live.clause === null);
  ok("both halves are included when both hold something", live.includeCurve === true && live.includeAmm === true);
  /* Including a side that holds nothing would add instructions and cost to move zero, and on
     the pump-amm side would create and close a token account for no reason. */
  ok("the curve side is left out when it holds only rent",
    decide(vault({ curveLamports: SYSTEM_RENT_EXEMPT_LAMPORTS, ammLamports: 10_000_000 }), { live: true }).includeCurve === false);
  ok("the pump-amm side is left out when its account holds nothing",
    decide(vault({ curveLamports: SYSTEM_RENT_EXEMPT_LAMPORTS + 50_000_000 }), { live: true }).includeAmm === false);

  /* DRY BY DEFAULT, and the dry decision is a first-class row: it is the evidence an operator
     reads before arming, so it must not be folded in with "there was nothing there". */
  const dry = decide(rich);
  ok("the shipped default signs nothing", FEE_LANE_DEFAULTS.live === false && dry.claim === false && dry.clause === "not_live");
  ok("...but it still computed what it would have taken",
    dry.grossLamports === 60_000_000 && /would claim 0\.060000 SOL/.test(dry.message));

  /* A claim is a signature, and HARD STOP means this wallet signs nothing. The owner's
     instruction has no exception for the profitable path. */
  const stopped = decide(rich, { live: true }, true);
  ok("HARD STOP refuses a claim, profitable or not", stopped.claim === false && stopped.clause === "hard_stop");
  ok("...and says a claim is a signature like any other", /a claim is a signature like any other/.test(stopped.message));
  ok("the sentinel is checked BEFORE the vault reading, so a stop cannot be out-argued by a big number",
    decide(vault({ readable: false }), { live: true }, true).clause === "hard_stop");

  ok("no creator at all is its own clause", decide(null).clause === "no_creator");
  ok("every clause the lane can report is declared",
    [unreadableClause(), "below_floor", "not_live", "hard_stop", "no_creator"].every((c) => SKIP_CLAUSES.includes(c)));
  function unreadableClause() { return "unreadable"; }
}

console.log("\narming: the acknowledgement has to carry the wallet");
{
  ok("a dry lane needs no acknowledgement, no submitter and no wallet",
    typeof createFeeLane({ readClaimable: async () => vault() }).tick === "function");
  ok("a lane with no vault reader is refused outright",
    threw(() => createFeeLane({})) instanceof FeeLaneError);
  ok("a live lane with no submitter is refused",
    threw(() => createFeeLane({ readClaimable: async () => vault(), cfg: { live: true } })).clause === "submit_missing");
  ok("a live lane with no creator is refused",
    threw(() => createFeeLane({ readClaimable: async () => vault(), submit: async () => ({}), cfg: { live: true } })).clause === "creator_missing");
  const expected = feeArmSentence({ creator: CREATOR, wallet: WALLET });
  ok("the sentence names both wallets, so it cannot be typed without reading them",
    expected.includes(CREATOR) && expected.includes(WALLET));
  const refused = threw(() => createFeeLane({
    readClaimable: async () => vault(), submit: async () => ({}), creator: CREATOR, wallet: WALLET,
    cfg: { live: true }, liveAck: "I acknowledge Claude Co claims creator fees",
  }));
  ok("a nearly-right acknowledgement is refused, not accepted", refused.clause === "arming_refused");
  ok("...and the refusal prints the exact sentence to type", refused.message.includes(expected));
  ok("the exact sentence arms it",
    typeof createFeeLane({ readClaimable: async () => vault(), submit: async () => ({ ok: true }),
      creator: CREATOR, wallet: WALLET, cfg: { live: true }, liveAck: expected }).tick === "function");
}

console.log("\none pass, end to end, and it never throws");
{
  const rows = [];
  const book = (r) => rows.push(r);
  const rich = vault({ curveLamports: SYSTEM_RENT_EXEMPT_LAMPORTS + 50_000_000, ammLamports: 10_000_000 });

  const dryLane = createFeeLane({ creator: CREATOR, readClaimable: async () => rich, book, clock: () => 1_000 });
  const dryRow = await dryLane.tick();
  ok("a dry pass records what it WOULD have claimed, as its own kind",
    dryRow.kind === "claim_would_have" && dryRow.decision.grossLamports === 60_000_000);
  ok("...and that kind is distinct from 'there was nothing there'", FEE_RECORD_KINDS.includes("claim_would_have")
    && FEE_RECORD_KINDS.includes("claim_skipped"));
  ok("the row is written to the book with a stamp and a version",
    rows.length === 1 && rows[0].atMs === 1_000 && rows[0].laneVersion === FEE_LANE_VERSION);
  ok("nothing was signed", dryLane.stats().claimed === 0 && dryLane.stats().skipped === 1);

  const ack = feeArmSentence({ creator: CREATOR, wallet: WALLET });
  const sent = [];
  const liveLane = createFeeLane({
    creator: CREATOR, wallet: WALLET, cfg: { live: true }, liveAck: ack, book,
    readClaimable: async () => rich,
    submit: async (args) => { sent.push(args); return { ok: true, signature: "sig1", lamports: 59_500_000 }; },
  });
  const landedRow = await liveLane.tick();
  ok("a live pass signs through the submitter and books what LANDED",
    landedRow.kind === "claim_landed" && landedRow.lamports === 59_500_000);
  /* THE ESTIMATE IS KEPT BESIDE THE ACTUAL, never instead of it: booking an estimate as
     revenue is how a revenue line starts drifting from the wallet. */
  ok("...with the estimate beside it rather than in place of it",
    landedRow.estimatedLamports === 60_000_000 && landedRow.lamports !== landedRow.estimatedLamports);
  ok("...and booked under its own revenue kind, never as a trade", landedRow.revenueKind === "creator_fee");
  ok("the submitter was handed the decision it is signing", sent.length === 1 && sent[0].decision.claim === true);
  ok("the counters follow the money", liveLane.stats().claimed === 1 && liveLane.stats().lamportsClaimed === 59_500_000
    && Math.abs(liveLane.stats().solClaimed - 0.0595) < 1e-9);

  /* A submitter that cannot report the amount must book UNKNOWN, not the estimate. */
  const quietLane = createFeeLane({ creator: CREATOR, wallet: WALLET, cfg: { live: true }, liveAck: ack, book,
    readClaimable: async () => rich, submit: async () => ({ ok: true, signature: "sig2" }) });
  const quietRow = await quietLane.tick();
  ok("a claim whose amount the submitter cannot report is booked as unknown, not as the estimate",
    quietRow.kind === "claim_landed" && quietRow.lamports === null && quietRow.estimatedLamports === 60_000_000);

  const failLane = createFeeLane({ creator: CREATOR, wallet: WALLET, cfg: { live: true }, liveAck: ack, book,
    readClaimable: async () => rich, submit: async () => { throw new Error("blockhash expired"); } });
  const failedRow = await failLane.tick();
  ok("a claim the chain rejected books a failure and no revenue",
    failedRow.kind === "claim_failed" && /blockhash expired/.test(failedRow.error) && failedRow.lamports === undefined);
  ok("...and the counters do not count it as claimed",
    failLane.stats().failed === 1 && failLane.stats().lamportsClaimed === 0);
  ok("a submitter that reports neither success nor error is a failure, not a silent success",
    (await createFeeLane({ creator: CREATOR, wallet: WALLET, cfg: { live: true }, liveAck: ack,
      readClaimable: async () => rich, submit: async () => ({}) }).tick()).kind === "claim_failed");

  /* NEVER THROWS. A fee lane that dies takes the revenue line with it, and it runs on a timer
     nobody is watching. */
  const hostile = createFeeLane({ creator: CREATOR,
    readClaimable: async () => { throw new Error("rpc down"); },
    control: () => { throw new Error("sentinel unreadable"); },
    book: () => { throw new Error("disk full"); } });
  const hostileRow = await arose(() => hostile.tick());
  ok("a pass where the vault read, the sentinel and the book ALL throw does not throw", hostileRow === null);
  /* An unreadable sentinel must fail CLOSED — treated as a hard stop, never as "no stop". */
  const stoppedRow = await hostile.tick();
  ok("...and an unreadable sentinel is treated as a HARD STOP, not as permission",
    stoppedRow.clause === "hard_stop");
  ok("...and a book that cannot be written costs a row in a report, never a decision",
    hostile.stats().bookErrors === 2 && hostile.stats().passes === 2);
}

console.log("\nthe number this module refuses to produce");
{
  const summary = feeSummary({
    feeRows: [
      { kind: "claim_landed", lamports: 14_515_000_000 },
      { kind: "claim_landed", lamports: null },
      { kind: "claim_would_have", decision: { grossLamports: 100_000_000 } },
      { kind: "claim_failed" },
      "not an object", null,
    ],
    tradingSol: -0.361,
  });
  ok("fee revenue is reported", Math.abs(summary.feeSol - 14.515) < 1e-9 && summary.feeClaims === 2);
  ok("trading is reported separately and by name", summary.tradingSol === -0.361);
  /* THE ASSERTION THIS WHOLE FILE EXISTS FOR. */
  for (const forbidden of ["total", "totalSol", "pnl", "pnlSol", "net", "netSol", "combined", "sum"])
    ok(`there is no \`${forbidden}\` field — their +15.6 SOL is exactly this addition`, !(forbidden in summary));
  ok("and the summary carries the sentence saying so", /never summed/.test(summary.note));

  /* A claim whose amount was never reported must be COUNTED, so `feeSol` can never quietly be
     a subset of what arrived while looking like the whole of it. */
  ok("an unreported claim amount is counted and flagged, not ignored",
    summary.claimsWithUnreportedAmount === 1 && summary.feeSolComplete === false);
  ok("...and a complete book says so", feeSummary({ feeRows: [{ kind: "claim_landed", lamports: 1 }] }).feeSolComplete === true);
  ok("would-have rows are kept apart from real ones", summary.wouldHaveClaims === 1 && Math.abs(summary.wouldHaveSol - 0.1) < 1e-9);
  ok("failed claims are counted rather than dropped", summary.failedClaims === 1);
  ok("malformed rows are skipped without breaking the summary", summary.feeClaims === 2);
  ok("no trading figure reads as null, not as zero", feeSummary({ feeRows: [] }).tradingSol === null);

  const src = fs.readFileSync(new URL("./fee-lane.mjs", import.meta.url), "utf8");
  ok("nothing in the module adds a fee figure to a trading figure",
    !/tradingSol\s*\+/.test(src) && !/\+\s*tradingSol/.test(src));
  ok("the module opens no connection and holds no key",
    !/new Connection\(/.test(src) && !/Keypair/.test(src) && !/signTransaction/.test(src));
  ok("the reason the separation is physical rather than a flag is written down",
    /a different file/.test(src) && /survives contact with its owner/.test(src));
}

console.log("\nwiring");
{
  const poller = fs.readFileSync(new URL("./poller.mjs", import.meta.url), "utf8");
  ok("the lane runs on its OWN timer, independent of the desk and the sniper",
    /const FEE_CLAIM_MODE = String\(process\.env\.FEE_CLAIM \|\| "off"\)/.test(poller)
    && /setInterval\(feeTick, feeLane\.intervalMs\)/.test(poller));
  ok("off is the shipped default, so an upgrade changes nothing", /FEE_CLAIM \|\| "off"/.test(poller));
  /* FEE_CLAIM=live IS REFUSED, AND NOT AS A GAP. A coin's creator fee is paid to the wallet that
     created the coin, which is not this burner and should not be: the burner's security story is
     that the only key on that disk is one generated there. bagworkagent.fun's server holds its
     agents' keys and signs for them; this one does not, and neither does the bot. The lane reads,
     the owner signs at /fees.html. */
  ok("live is refused by name, as a settled design rather than a gap",
    /FEE_CLAIM=live is not honoured, and this is now a settled design/.test(poller)
    && /submit: null,/.test(poller));
  ok("...and the refusal says WHERE the owner signs instead", /\/fees\.html/.test(poller));
  ok("...and why the key is not on this machine", /widen the blast radius/.test(poller));
  ok("it books to its OWN file, not the trading journal", /feeBookPath\(STATE_DB\)/.test(poller));
  ok("HARD STOP governs a claim; PAUSE ENTRIES does not, because a claim takes money IN",
    /control: \(\) => \(\{ hardStop: hardStop\(\) === true \}\)/.test(poller)
    && /PAUSE ENTRIES does not/.test(poller));
  ok("a missing account is read as a definite zero, an unreadable one as null",
    /No account is no tokens — a definite zero/.test(poller));
  ok("it cannot take the desk down", /fee lane did not start/.test(poller));
  ok("the modules are imported dynamically, so FEE_CLAIM=off costs nothing",
    !/^import .*fee-lane/m.test(poller) && /import\("\.\/fee-lane\.mjs"\)/.test(poller));

  const sink = fs.readFileSync(new URL("./shadow-sink.mjs", import.meta.url), "utf8");
  ok("the fee book is a different FILE from the shadow book and the journal",
    /export const feeBookPath = \(stateDb\) => `\$\{String\(stateDb\)\}\.fees\.jsonl`/.test(sink));
  ok("...and why the separation is physical rather than a flag is written where the path is",
    /survives edits that a rule written in a comment does not/.test(sink));
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} test-fee-lane  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
