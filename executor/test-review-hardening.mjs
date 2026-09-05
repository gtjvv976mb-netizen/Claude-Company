/**
 * THE 2026-09-01 ADVERSARIAL-REVIEW HARDENING — eight confirmed findings, each pinned.
 *
 * The common shape of all eight: the only number a guard consulted was one the
 * counterparty authored, or a state write landed on an object the state had already
 * abandoned. Every test here builds the exact scenario from the review and asserts the
 * repair — and, where the repair could over-reach, asserts the legitimate case is
 * untouched.
 */
import { pricePolicy, POLICY_VERSION } from "./trade-policy.mjs";
import { validateSimulationEffects } from "./jupiter.mjs";

let pass = 0, fail = 0;
const ok = (name, condition, detail = "") => {
  if (condition) { pass++; console.log(`PASS  ${name}${detail ? `  — ${detail}` : ""}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ""}`); }
};

/* ── F8: the high-water mark needs two witnesses ─────────────────────────────── */
console.log("\nTHE RATCHET NEEDS TWO WITNESSES");
{
  const cfg = { breakevenArmX: 1.35, trailArmX: 1.5, trailPct: 0.25, takeProfitX: 0, maxAgeHours: 0, honorDeskTarget: false };
  // The review's exact reproduction: real 1.1x, one glitch tick at 1.9x.
  let p = { entry: 1, stop: 0.8, high: 1.0, openedAtMs: 0 };
  const t1 = pricePolicy({ position: p, mark: 1.9, config: cfg, nowMs: 1 });
  ok("a lone 1.9x spike does not ratchet the stop", t1.position.stop === 0.8,
    `stop stays ${t1.position.stop} (used to jump to 1.425 and force-sell next tick)`);
  const t2 = pricePolicy({ position: t1.position, mark: 1.1, config: cfg, nowMs: 2 });
  ok("...and the next honest tick HOLDS instead of force-selling", t2.action === "hold",
    `${t2.action} (${t2.reason}) — the manufactured 'ratcheted stop' sell is gone`);
  /* Two wrong expectations preceded this one, both instructive. First I asserted
   * pendingHigh === 0 after the honest tick — but 1.1 is above the old 1.0 high, so
   * staging it is correct. Then I asserted high stays 1.0 — but the spike acts as
   * first witness and the honest 1.1 as second, committing 1.1, WHICH IS TRUE: the
   * real price did print 1.1. The actual invariant is narrower and is the one that
   * matters: the SPIKE VALUE itself can never become the high, and no stop may arm
   * off it. */
  ok("...the spike value itself can never commit", t2.position.high <= 1.1 && t2.position.high !== 1.9,
    `high=${t2.position.high} — bounded by the honest sample, never the 1.9 glitch`);
  const t3 = pricePolicy({ position: t2.position, mark: 0.95, config: cfg, nowMs: 3 });
  ok("...and a down-tick clears the stage entirely", (Number(t3.position.pendingHigh) || 0) === 0);

  // A genuine run still ratchets — one tick late, both samples real, lower one kept.
  let q = { entry: 1, stop: 0.8, high: 1.0, openedAtMs: 0 };
  const r1 = pricePolicy({ position: q, mark: 1.6, config: cfg, nowMs: 1 });
  const r2 = pricePolicy({ position: r1.position, mark: 1.7, config: cfg, nowMs: 2 });
  ok("a real run commits on the second witness", r2.position.high === 1.6,
    `high=${r2.position.high}, the LOWER of the two consecutive samples`);
  ok("...and arms the trail off the confirmed high", r2.position.stop === 1.6 * 0.75,
    `stop=${r2.position.stop}`);
  const r3 = pricePolicy({ position: r2.position, mark: 1.15, config: cfg, nowMs: 3 });
  ok("...and the ratcheted stop still fires on a genuine giveback", r3.action === "sell", r3.reason);
  ok("the policy version says so", POLICY_VERSION === "desk-led-v4",
    `${POLICY_VERSION} — behavior changed twice (v3 witnesses, v4 desk-led); recorded decisions must not claim an old policy`);
}

/* ── F1: the quote must agree with the chain ─────────────────────────────────── */
console.log("\nTHE QUOTE MUST AGREE WITH THE CHAIN, NOT ONLY WITH ITSELF");
{
  /* An ENTRY (WSOL in → token out), the direction the finding attacks. The WSOL input
   * side may legitimately be absent, so the only account that must decode is the
   * post-simulation destination — packed here byte-for-byte as a real SPL token
   * account, because the check under test lives BEHIND the decoder and a fixture the
   * decoder rejects tests nothing. */
  const { Keypair } = await import("@solana/web3.js");
  const bs58 = (await import("bs58")).default;
  const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const WSOL = "So11111111111111111111111111111111111111112";
  const walletKey = Keypair.generate().publicKey;
  const outMint = Keypair.generate().publicKey.toBase58();
  const lam = (v) => ({ lamports: v, owner: "11111111111111111111111111111111",
    executable: false, data: Buffer.alloc(0) });
  const splAccount = (amount) => {
    const d = Buffer.alloc(165);
    Buffer.from(bs58.decode(outMint)).copy(d, 0);           // mint
    walletKey.toBuffer().copy(d, 32);                        // owner
    d.writeBigUInt64LE(BigInt(amount), 64);                  // amount
    d[108] = 1;                                              // state: initialized
    return { lamports: 2_039_280, owner: TOKEN_PROGRAM, executable: false, data: d };
  };
  const AMOUNT = 1_000_000;                                  // 0.001 SOL in
  const cfgSim = { maxNetworkFeeLamports: 5_000, maxRentLamports: 3_000_000,
    maxQuoteShortfallPct: 15, maxNetworkFeePct: 100 };
  const run = ({ quoted, received }) => {
    try {
      validateSimulationEffects(
        { wallet: lam(1_000_000_000), input: null, output: null },
        // The destination ATA's rent lamports leave the wallet too — custody
        // aggregation counts the ATA as wallet custody, so the books must balance.
        { wallet: lam(1_000_000_000 - AMOUNT - 5_000 - 2_039_280), input: null, output: splAccount(received) },
        { wallet: walletKey.toBase58(), inputMint: WSOL, outputMint: outMint,
          amountRaw: String(AMOUNT),
          minOutputRaw: String(Math.floor(quoted * 0.97)), quotedOutputRaw: String(quoted),
          inputProgram: TOKEN_PROGRAM, outputProgram: TOKEN_PROGRAM },
        cfgSim);
      return null;
    } catch (e) { return e.message; }
  };
  // Honest quote: chain delivers roughly what was quoted.
  const honest = run({ quoted: 100_000_000, received: 100_500_000 });
  ok("an honest quote passes", honest === null, honest ?? "clean");
  // Low-balled quote: chain delivers 20x the quote — the signed minOut floor is garbage.
  const lowball = run({ quoted: 5_000_000, received: 100_000_000 });
  ok("a low-balled quote is refused even though actual >> minOut",
    /below reality/.test(lowball ?? ""),
    "the old check only asked actual >= minOut, which a garbage floor trivially passes");
  // Slight over-delivery (positive slippage) stays inside the tolerance.
  const slight = run({ quoted: 100_000_000, received: 108_000_000 });
  ok("ordinary positive slippage is not punished", slight === null, slight ?? "8% over, inside the 15% cap");
}

/* ── F2/F3/F5/F6 shape checks: the code paths carry the new contracts ────────── */
console.log("\nSIGNING-PATH CONTRACTS (asserted structurally — the live tests exercise them end-to-end)");
{
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("./jupiter.mjs", import.meta.url), "utf8"));

  const prepareBody = src.slice(src.indexOf("async _prepareUnsigned"), src.indexOf("async preflightExitMark"));
  const buildBody = src.slice(src.indexOf("async _buildSigned"), src.indexOf("async _simulateUnsigned"));
  ok("F2: the order expiry is bounded against the chain before signing",
    /getBlockHeight\("confirmed"\)/.test(prepareBody) && /blockHeightWindow/.test(prepareBody) &&
    buildBody.indexOf("_prepareUnsigned") < buildBody.indexOf("tx.sign([this.keypair])"),
    "an unbounded lastValidBlockHeight wedged the journal and disarmed every exit");

  /* F3/F5, THIRD design — the re-review killed the second. Journal-then-simulate
   * marked a refused simulation "submitted", and _resume treats any submitted attempt
   * without an execute response as a transport retry: every refused transaction was
   * BROADCAST one tick later, converting the refusal into a send trigger, and the
   * "signed" state during simulation dodged the expiry fence (double-buy). The root
   * cause both times: broadcastable bytes in a state the journal cannot express. Now
   * nothing broadcastable exists until after the chain agrees: the simulation runs on
   * the UNSIGNED transaction (a signature authorizes, it does not change execution),
   * a refusal costs nothing and journals nothing, and the first broadcastable
   * disclosure anywhere is the /execute POST — behind recordSigned and markSubmitted,
   * the states the reconciliation machinery actually fences. */
  ok("F3: the simulation runs on the UNSIGNED transaction, before tx.sign",
    prepareBody.indexOf("_simulateUnsigned") !== -1 &&
    buildBody.indexOf("_prepareUnsigned") < buildBody.indexOf("tx.sign([this.keypair])"),
    "nothing disclosed during simulation can be broadcast");
  ok("F3: the simulation verifies no signature, because there is none yet",
    /sigVerify: false/.test(src.slice(src.indexOf("async _simulateUnsigned"))),
    "sigVerify:true would reject the unsigned bytes");

  const exec = src.slice(src.indexOf("async executeIntent"), src.indexOf("async recoverPending"));
  ok("F5: a refused simulation journals NOTHING — no state for _resume to broadcast",
    !/markSubmitted\(intent\.id, attempt\.attempt\)/.test(exec) && !/refused after signing/.test(exec),
    "the second design's markSubmitted turned every refusal into a next-tick send");
  ok("F5: recordSigned runs only after the chain has agreed with the quote",
    exec.indexOf("_buildSigned") < exec.indexOf("recordSigned"),
    "only a simulation-approved transaction is ever signed and journaled");
  ok("F6: exits may retry past the entry cap",
    /maxExitAttempts/.test(exec) && /cooling down/.test(exec),
    "a stop that failed three times during the dump that fired it is no longer dead forever");
  ok("F6: entries keep the hard cap of maxAttempts",
    /if \(!isExit && count >= this\.cfg\.maxAttempts\)/.test(exec),
    "money not spent is money kept — only exits earn extra attempts");
}

/* ── F4/F7 shape checks in the poller ────────────────────────────────────────── */
console.log("\nSTATE-HANDLING CONTRACTS IN THE POLLER");
{
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("./poller.mjs", import.meta.url), "utf8"));
  const manage = src.slice(src.indexOf("async function manageOpen"), src.indexOf("let ticking = false"));
  ok("F4: positions are re-resolved from live state each iteration, not held from a snapshot",
    /for \(const posKey of openList\(\)\.map\(\(p\) => p\.mint\)\)/.test(manage) &&
    /openList\(\)\.find\(\(p\) => p\.mint === posKey\)/.test(manage),
    "an exit mid-pass swaps S for a clone; writes to the old array were silently dropped");
  /* Index the LAST catch, not a counted one — the first version picked the quote catch
   * and read code that was never the outer handler. desk-led-v4 moved the handler body
   * into recordPositionFailure so the mirror pass records a failed exit identically. */
  const afterLastCatch = manage.split("catch (error)").at(-1) ?? "";
  const recorder = src.slice(src.indexOf("function recordPositionFailure"), src.indexOf("let ticking = false"));
  ok("F4: the outer catch writes to the live object too",
    /recordPositionFailure\(posKey, error, "manage"\)/.test(afterLastCatch) &&
      recorder.includes("openList().find((p) => p.mint === posKey)"),
    "a failure flag on a detached object never reaches the entry gate that reads it");
  ok("F7: a SOL/USD outage falls back to the cached rate instead of blinding valuation",
    /solUsdCache/.test(manage) && /valuation stays readable/.test(manage),
    "desk-led-v4: the cached rate keeps the heartbeat and board readable; it arms no stop (there is none)");
  ok("F7: the fallback is bounded by age",
    /SOL_USD_CACHE_MAX_AGE_MS/.test(manage),
    "past 24h the old fail-closed hold applies — a cache is not a licence");
  ok("valuation consumes the chain-simulated executable mark, never Jupiter's display quote",
    /preflightExitMark/.test(manage) && /observation\.actualOutputRaw/.test(manage) &&
      !/jupiter\.quote\(pos\.mint/.test(manage),
    "an inflated aggregator quote cannot flatter the board's P&L");
  ok("desk-led-v4: an unusable executable mark FLAGS health and never sells",
    /noteMarkUnavailable\(pos/.test(manage) && !/confirmExitMarkFailureWitness/.test(manage) &&
      !/independent executable exit mark unavailable on two consecutive ticks/.test(manage) &&
      !/sustained outage; latching a risk-reducing exit/.test(manage),
    "the two-witness latch and the outage latch were bot-originated exits (TOAD 2026-09-04; Shrek call 55)");
  ok("desk-led-v4: the only sellAll in the valuation pass is the retry of an already-latched exit",
    (manage.match(/await sellAll\(/g) || []).length === 1 &&
      /if \(pos\.exitExecutionRequired\) \{\s*\n\s*await sellAll\(/.test(manage),
    `${(manage.match(/await sellAll\(/g) || []).length} sellAll call(s) in manageOpen`);
  const limits = src.slice(src.indexOf("const LIVE_LIMITS"), src.indexOf("const log ="));
  ok("the new bounds are FROZEN live ceilings like every other cap",
    /blockHeightWindow: 600/.test(limits) && /maxQuoteShortfallPct: 15/.test(limits) && /maxExitAttempts: 12/.test(limits),
    "env can lower them in live mode, never raise them");
}

/* ── THIRD-PASS FIXES (2026-09-01, seven confirmed, zero refuted) ────────────── */
console.log("\nTHIRD-PASS CONTRACTS");
{
  const fs = await import("node:fs");
  const jup = fs.readFileSync(new URL("./jupiter.mjs", import.meta.url), "utf8");
  const pol = fs.readFileSync(new URL("./poller.mjs", import.meta.url), "utf8");
  const pent = fs.readFileSync(new URL("../src/penthouse.js", import.meta.url), "utf8");
  const idx = fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  const callsSrc = fs.readFileSync(new URL("../src/calls.js", import.meta.url), "utf8");

  const resume = jup.slice(jup.indexOf("async _resume"), jup.indexOf("async executeIntent"));
  ok("P3-1: _resume checks the chain height on a 'signed' attempt BEFORE disclosing it",
    /attempt\.state === "signed"/.test(resume) &&
    // Compare against the CALL, not the word — the explanatory comment mentions
    // markSubmitted before the code does, which is exactly what tripped this first.
    resume.indexOf("getBlockHeight") < resume.indexOf("this.journal.markSubmitted("),
    "dead bytes route to the safe markExpired path instead of latching AMBIGUOUS after a laptop sleep");

  const reconcile = jup.slice(jup.indexOf("async _reconcile"), jup.indexOf("async _resume"));
  ok("P3-7: a never-disclosed 'signed' attempt gets one quick status read, not the 30s wait",
    /attempt\.state === "signed"/.test(reconcile) && /_waitFinalized/.test(reconcile),
    "a wedged signed attempt must not stall every stop-evaluation tick by finalityTimeout");

  const exec = jup.slice(jup.indexOf("async executeIntent"), jup.indexOf("async recoverPending"));
  /* Updated by the fourth pass: the cap still binds from attempt one, but over
   * FEE-BEARING attempts — counting free expiries let two laptop sleeps kill a stop. */
  ok("P3-6: the exit cap binds from attempt ONE, outside the entry-cap branch",
    /if \(isExit && exitFeeAttempts >= exitCap\)/.test(exec) &&
    exec.indexOf("exitFeeAttempts >= exitCap") < exec.indexOf("count >= this.cfg.maxAttempts"),
    "an operator's MAX_EXIT_TX_ATTEMPTS below the entry cap was silently ignored");

  ok("P3-5: the SOL/USD cache is durable, not process-memory",
    /setMeta\("sol_usd_cache"/.test(pol) && /getMeta\("sol_usd_cache"/.test(pol),
    "restarts correlate with the outages the cache exists for");

  ok("P3-3: provenance rows carry no mark — one observation can no longer confirm itself",
    !/noteEvent\(call\.id, "evidence", [^)]*entry_ref\)/.test(pent) &&
    !/noteEvent\(call\.id, "mandate", [^)]*entry_ref\)/.test(pent),
    "duplicate same-value rows satisfied the pair rule and voided the two-witness invariant");

  ok("P3-2: sub-tick marks give the pair rule honest neighbours inside a monitor pass",
    /export async function subTickMarks/.test(pent) && /PENTHOUSE_SUBMARK_SECS/.test(idx),
    "the two-witness window was the 10-minute pass — 40x the 15s the policy priced");

  ok("P3-4: a close print is provisional until one confirming read agrees",
    /close_restated/.test(pent) && /close_confirmed/.test(callsSrc),
    "one anomalous 6x read booked a manufactured win into the stats tenants choose floors by");
}

/* ── FOURTH-PASS FIXES (2026-09-01, twelve confirmed → eight distinct) ─────────── */
console.log("\nFOURTH-PASS CONTRACTS");
{
  const fs = await import("node:fs");
  const jup = fs.readFileSync(new URL("./jupiter.mjs", import.meta.url), "utf8");
  const pol = fs.readFileSync(new URL("./poller.mjs", import.meta.url), "utf8");
  const oracle = fs.readFileSync(new URL("./sol-usd-oracle.mjs", import.meta.url), "utf8");
  const pent = fs.readFileSync(new URL("../src/penthouse.js", import.meta.url), "utf8");
  const idx = fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8");

  const reconcile = jup.slice(jup.indexOf("async _reconcile"), jup.indexOf("async _resume"));
  /* Fifth pass changed the handoff syntax (the result is captured so the fast read's
   * observation can be OR'd in) — the contract is unchanged: an observed status goes
   * to the FULL _waitFinalized, and no hand-rolled mirror of its shape exists. */
  ok("P4-1: an observed status hands off to the FULL _waitFinalized, no hand-rolled mirror",
    /await this\._waitFinalized\(attempt\.signature\)/.test(reconcile) &&
    !/outcome: "finalized", transaction, observedStatus/.test(reconcile),
    "a null-transaction index lag must retry, never latch a landed SUCCESS as AMBIGUOUS");

  const resume = jup.slice(jup.indexOf("async _resume"), jup.indexOf("async executeIntent"));
  ok("P4-2: the resume expiry bound matches _buildSigned's convention (>=)",
    /remainingByProvider\.some\(\(remaining\) => remaining <= 0\)/.test(resume),
    "at height == lastValid the next block is lastValid+1: the bytes are already dead");
  ok("P4-11: first disclosure requires independent heights from both RPCs",
    /Promise\.allSettled/.test(resume) && /secondaryConnection\?\.getBlockHeight/.test(resume) &&
      /remaining > blockHeightWindow/.test(resume),
    "one unavailable, stale, or forged-height RPC can never authorize disclosure");

  const exec = jup.slice(jup.indexOf("async executeIntent"), jup.indexOf("async recoverPending"));
  ok("P4-4: only FEE-BEARING attempts spend the exit budget",
    /exitFeeAttempts/.test(exec) && /state === "failed"/.test(exec),
    "two free laptop-sleep expiries must not kill a stop forever");

  ok("P4-3: the persisted SOL/USD cache age is bounded below as well as above",
    /usableSolUsdCache/.test(pol) &&
      /observedAgeMs < 0 \|\| publishAgeMs < 0/.test(oracle),
    "a backward clock step made the age negative and voided the staleness cap for hours");

  ok("P4-5: sub-tick marks arm once per process with a busy guard and minimum spacing",
    /_subTickArmed/.test(pent) && /_subTickBusy/.test(pent) && /minSpacingMs/.test(pent) &&
    /startSubTickMarks\(/.test(idx) && !/setInterval\(\(\) => \{ subTickMarks/.test(idx),
    "two racing intervals wrote near-duplicate marks that satisfied the pair rule");

  const sub = pent.slice(pent.indexOf("export async function subTickMarks"), pent.indexOf("export async function monitorCalls"));
  ok("P4-6: a close print is judged against the mark BEFORE it, not the price after",
    /preMark/.test(sub) && /postAgreesWithPre/.test(sub),
    "direction-blind post-close comparison restated honest stop closes to post-crash prices");
  ok("P4-8: both confirm/restate UPDATEs refuse to touch an already-confirmed close",
    (sub.match(/close_confirmed IS NULL/g) || []).length >= 3,
    "a settled print can never be re-opened by a later pass — the fifth-pass rebuild consolidated the UPDATEs into settle()");
  ok("P4-6b: with no pre-close witness the print stands — one witness cannot convict another",
    /one witness cannot convict another/.test(sub));
}

/* ── FIFTH-PASS FIXES (2026-09-01, seven findings, verified by hand after the
 *    panel's verifiers died on a session limit — behavioral coverage lives in
 *    test-close-confirm.mjs, which runs the REAL confirm loop against a real DB) ── */
console.log("\nFIFTH-PASS CONTRACTS");
{
  const fs = await import("node:fs");
  const jup = fs.readFileSync(new URL("./jupiter.mjs", import.meta.url), "utf8");
  const pent = fs.readFileSync(new URL("../src/penthouse.js", import.meta.url), "utf8");

  const resume = jup.slice(jup.indexOf("async _resume"), jup.indexOf("async executeIntent"));
  ok("P5-1: unreadable chain height HOLDS the signed bytes, never discloses them",
    /holding the bytes undisclosed/.test(resume),
    "the old fallback POSTed dead bytes and latched AMBIGUOUS — landing was never the risk, the state transition was");

  const reconcile = jup.slice(jup.indexOf("async _reconcile"), jup.indexOf("async _resume"));
  ok("P5-2: the fast read's observation survives the handoff to _waitFinalized",
    /observedStatus: true \}/.test(reconcile),
    "an observed signature must never time out into permission for a replacement");
  ok("P5-3: the reconcile height read is fenced to the secondary too",
    /primary RPC unavailable for the expiry height read/.test(jup),
    "the resume fence bought nothing if the very next read threw on the same outage");

  const exec = jup.slice(jup.indexOf("async executeIntent"), jup.indexOf("async recoverPending"));
  ok("P5-4: the cooldown keys on FEE-BEARING attempts, same counter as the cap",
    /exitFeeAttempts >= this\.cfg\.maxAttempts/.test(exec),
    "free expiries must not arm a 60s throttle on a stop that has spent nothing");

  ok("P5-5: every witness mark enters by one spacing-guarded door",
    /export function writeWitnessMark/.test(pent) &&
    /if \(!writeWitnessMark\(call\.id, now\.mark\)\)/.test(pent),
    "the monitor's unconditional mark let one cache interval witness itself via overlap");

  const sub = pent.slice(pent.indexOf("export async function subTickMarks"), pent.indexOf("export async function monitorCalls"));
  ok("P5-6: a restatement may never flatter the outcome",
    /flatters/.test(sub) && /never in the book's favour/.test(sub),
    "an honest dump-wick stop the followers really sold into must stand");
  ok("P5-7: closes stay eligible until confirmed; the post-close witness is history",
    /24 \* 3600e3/.test(sub) && /postMark/.test(sub),
    "the 10-minute window stranded exactly the closes most likely to be corrupt");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
