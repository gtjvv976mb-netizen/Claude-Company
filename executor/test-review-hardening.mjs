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
  ok("the policy version says so", POLICY_VERSION === "snipe-v3",
    "behavior changed; recorded decisions must not claim the old policy");
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

  const buildBody = src.slice(src.indexOf("async _buildSigned"), src.indexOf("async _simulateUnsigned"));
  ok("F2: the order expiry is bounded against the chain before signing",
    /getBlockHeight\("confirmed"\)/.test(buildBody) && /blockHeightWindow/.test(buildBody),
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
    buildBody.indexOf("_simulateUnsigned") !== -1 &&
    buildBody.indexOf("_simulateUnsigned") < buildBody.indexOf("tx.sign([this.keypair])"),
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
    /if \(!isExit\) throw new Error\(`intent \$\{intent\.id\} exhausted/.test(exec),
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
   * and read code that was never the outer handler. */
  const afterLastCatch = manage.split("catch (error)").at(-1) ?? "";
  ok("F4: the outer catch writes to the live object too",
    afterLastCatch.includes("openList().find((p) => p.mint === posKey)"),
    "a failure flag on a detached object never reaches the entry gate that reads it");
  ok("F7: a SOL/USD outage falls back to the cached rate instead of disarming stops",
    /solUsdCache/.test(manage) && /stops stay armed/.test(manage),
    "stops care about 20%+ token moves; SOL/USD drifts single digits in hours");
  ok("F7: the fallback is bounded by age",
    /SOL_USD_CACHE_MAX_AGE_MS/.test(manage),
    "past 24h the old fail-closed hold applies — a cache is not a licence");
  const limits = src.slice(src.indexOf("const LIVE_LIMITS"), src.indexOf("const log ="));
  ok("the new bounds are FROZEN live ceilings like every other cap",
    /blockHeightWindow: 600/.test(limits) && /maxQuoteShortfallPct: 15/.test(limits) && /maxExitAttempts: 12/.test(limits),
    "env can lower them in live mode, never raise them");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
