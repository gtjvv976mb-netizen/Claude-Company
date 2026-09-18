/**
 * MULTI-RELAY SUBMISSION AND THE TIP — the other half of "fastest in the market".
 *
 * The owner, 2026-09-18. Measured the day before: this bot lands a median 5 seconds behind
 * a curve's first trade with a median 12 buyers in front of it. Detection is one half of
 * that. This is the half between a signed transaction and a slot — where every competitive
 * stack fans the same bytes down several paths at once and pays a tip for inclusion, and
 * where this bot sent to two RPCs and hoped.
 *
 * The features are easy. What this file pins is the set of refusals that keep a submission
 * path from becoming a way to lose money quietly:
 *
 *   · NO TIP ADDRESS SHIPS IN THE REPO. A tip is an irreversible transfer to an address
 *     nobody in this process verified. A plausible-looking constant is exactly how money
 *     goes to the wrong wallet, so the operator supplies them and base58 is checked.
 *   · NO RELAY URL SHIPS EITHER, and a relay must be https: a submission carries a signed
 *     transaction, and sending one in clear hands the whole trade to the path.
 *   · A TIP HAS A CEILING, because it is paid on every attempt whether the trade lands or
 *     not. At a 0.1 SOL ticket, 0.01 SOL is already a tenth of the trade.
 *   · A 200 CARRYING A JSON-RPC ERROR IS A REFUSAL. Reading the status alone is how a
 *     rate-limited relay gets counted as a landed send.
 *   · SUBMISSION NEVER THROWS INTO THE TRADING PATH. The ordinary RPC sends are happening
 *     in parallel; a relay that is down, slow, lying or absent must cost a log line.
 *
 *   node test-snipe-relay.mjs
 */
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import fs from "node:fs";
import {
  calibrateTip, createRelaySubmitter, pickTipAccount, RELAY_LIMITS, relaysFromEnv,
  SnipeRelayError, tipAccountsFromEnv, tipInstruction,
} from "./snipe-relay.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
};
const threw = (fn, clause) => {
  try { fn(); return false; } catch (e) { return e instanceof SnipeRelayError && (!clause || e.clause === clause); }
};

const WALLET = Keypair.generate().publicKey;
const TIP = Keypair.generate().publicKey.toBase58();

console.log("\nthe tip is an instruction, because a tip outside the signed message is not paid");
{
  const ix = tipInstruction({ from: WALLET, to: TIP, lamports: 50_000 });
  ok("it is a System transfer", ix.programId.equals(SystemProgram.programId));
  ok("...from the trading wallet to the tip account, and nowhere else",
    ix.keys[0].pubkey.equals(WALLET) && ix.keys[1].pubkey.equals(new PublicKey(TIP)));
  ok("it refuses an address that is not base58", threw(() => tipInstruction({ from: WALLET, to: "not-an-address", lamports: 1 }), "tip_account_invalid"));
  ok("it refuses a missing address", threw(() => tipInstruction({ from: WALLET, to: null, lamports: 1 }), "tip_account_invalid"));
  for (const bad of [0, -1, 1.5, "x", null, undefined, NaN])
    ok(`it refuses a tip of ${JSON.stringify(bad)}`, threw(() => tipInstruction({ from: WALLET, to: TIP, lamports: bad }), "tip_invalid"));
  /* THE CEILING. A tip is paid on every attempt, landed or not. */
  ok("it refuses a tip above the module's ceiling",
    threw(() => tipInstruction({ from: WALLET, to: TIP, lamports: RELAY_LIMITS.maxTipLamports + 1 }), "tip_over_cap"));
  ok("...and the ceiling is a tenth of a 0.1 SOL ticket, not a tuning knob",
    RELAY_LIMITS.maxTipLamports === 10_000_000, `${RELAY_LIMITS.maxTipLamports} lamports`);
}

console.log("\nthe tip scales with contention, and never past the operator's cap");
{
  const base = 10_000, max = 200_000;
  ok("no contention pays the floor", calibrateTip({ baseLamports: base, maxLamports: max, contention: 0 }) === base);
  ok("full contention pays the cap", calibrateTip({ baseLamports: base, maxLamports: max, contention: 10, fullAt: 10 }) === max);
  ok("halfway is halfway", calibrateTip({ baseLamports: base, maxLamports: max, contention: 5, fullAt: 10 }) === 105_000);
  /* UNBOUNDED CONTENTION MUST NOT MEAN AN UNBOUNDED AUCTION. */
  ok("ten times the contention still pays the cap, never more",
    calibrateTip({ baseLamports: base, maxLamports: max, contention: 10_000, fullAt: 10 }) === max);
  ok("a nonsense contention reads as none, rather than as infinite",
    calibrateTip({ baseLamports: base, maxLamports: max, contention: "lots" }) === base);
  ok("it is monotone in contention", (() => {
    let prev = -1;
    for (let c = 0; c <= 12; c++) {
      const t = calibrateTip({ baseLamports: base, maxLamports: max, contention: c, fullAt: 10 });
      if (t < prev) return false;
      prev = t;
    }
    return true;
  })());
  ok("a cap below the floor is refused rather than silently swapped",
    threw(() => calibrateTip({ baseLamports: 100, maxLamports: 10 }), "tip_invalid"));
  ok("a cap above the module ceiling is refused",
    threw(() => calibrateTip({ baseLamports: 1, maxLamports: RELAY_LIMITS.maxTipLamports + 1 }), "tip_over_cap"));
}

console.log("\nrelays are the operator's, checked, and https only");
{
  ok("no relay ships by default", createRelaySubmitter({}).relays.length === 0);
  ok("a plain-http relay is refused — the bytes are a signed transaction",
    threw(() => createRelaySubmitter({ relays: [{ id: "a", url: "http://relay.example/x" }] }), "relays_invalid"));
  ok("a url that is not a url is refused",
    threw(() => createRelaySubmitter({ relays: [{ id: "a", url: "not a url" }] }), "relays_invalid"));
  ok("a relay with no id is refused", threw(() => createRelaySubmitter({ relays: [{ url: "https://a.example" }] }), "relays_invalid"));
  ok("too many relays are refused rather than fanned out to",
    threw(() => createRelaySubmitter({ relays: Array.from({ length: RELAY_LIMITS.maxRelays + 1 },
      (_, i) => ({ id: `r${i}`, url: "https://a.example" })) }), "relays_invalid"));
  ok("relays with no fetch to reach them are refused at construction, not at send time",
    threw(() => createRelaySubmitter({ relays: [{ id: "a", url: "https://a.example" }], fetchImpl: null }), "fetch_missing"));
}

console.log("\nthe env reader invents nothing");
{
  ok("no SNIPE_RELAYS means no relays", relaysFromEnv({}).length === 0);
  ok("no SNIPE_TIP_ACCOUNTS means no tip is ever built", tipAccountsFromEnv({}).length === 0);
  const r = relaysFromEnv({ SNIPE_RELAYS: "jito=https://a.example/api, alt=https://b.example/api" });
  ok("id=url pairs parse", r.length === 2 && r[0].id === "jito" && r[1].url === "https://b.example/api", JSON.stringify(r));
  ok("a malformed pair is refused rather than half-read",
    threw(() => relaysFromEnv({ SNIPE_RELAYS: "https://a.example" }), "relays_invalid"));
  ok("tip accounts are base58-checked", tipAccountsFromEnv({ SNIPE_TIP_ACCOUNTS: TIP }).length === 1);
  ok("...and one bad address refuses the whole list, never just itself",
    threw(() => tipAccountsFromEnv({ SNIPE_TIP_ACCOUNTS: `${TIP},oops` }), "tip_account_invalid"));
}

console.log("\npicking a tip account spreads across them and never invents one");
{
  ok("no accounts means no tip account", pickTipAccount([]) === null && pickTipAccount(null) === null);
  const list = ["a", "b", "c"];
  ok("it picks from the list", list.includes(pickTipAccount(list)));
  ok("random at its extremes stays inside the list",
    pickTipAccount(list, () => 0) === "a" && pickTipAccount(list, () => 0.999999) === "c");
  /* An out-of-range random must not index past the end. */
  ok("a broken random cannot index off the end",
    pickTipAccount(list, () => 1) === "c" && pickTipAccount(list, () => -5) === "a" && pickTipAccount(list, () => NaN) === "a");
}

console.log("\nthe fan-out: every path at once, first answer reported, nothing thrown");
{
  const calls = [];
  const relay = (id, behaviour) => ({ id, url: `https://${id}.example/api` });
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    const id = new URL(url).hostname.split(".")[0];
    if (id === "slow") { await new Promise((r) => setTimeout(r, 30)); return { status: 200, json: async () => ({ result: "SIGSLOW" }) }; }
    if (id === "fast") return { status: 200, json: async () => ({ result: "SIGFAST" }) };
    if (id === "http500") return { status: 500, json: async () => ({}) };
    if (id === "rpcerror") return { status: 200, json: async () => ({ error: { message: "rate limited" } }) };
    if (id === "boom") throw new Error("connection refused");
    if (id === "garbage") return { status: 200, json: async () => { throw new Error("not json"); } };
    return { status: 200, json: async () => ({ result: "SIG" }) };
  };
  let t = 0;
  const sub = createRelaySubmitter({
    relays: ["fast", "slow", "http500", "rpcerror", "boom", "garbage"].map((id) => relay(id)),
    fetchImpl, clock: () => (t += 1),
  });
  const report = await sub.submit("BASE64BYTES");

  ok("every relay was tried, in one fan-out", report.attempted === 6 && calls.length === 6, `${report.attempted} attempted`);
  ok("the same bytes went to all of them", calls.every((c) => c.body.params[0] === "BASE64BYTES"));
  ok("...as sendTransaction, base64, preflight skipped (the RPCs already simulated)",
    calls.every((c) => c.body.method === "sendTransaction" && c.body.params[1].encoding === "base64"
      && c.body.params[1].skipPreflight === true));
  const byId = Object.fromEntries(report.results.map((r) => [r.id, r]));
  ok("a clean 200 with a result is a success", byId.fast.ok === true && byId.fast.signature === "SIGFAST");
  ok("an HTTP 500 is a failure and says so", byId.http500.ok === false && /HTTP 500/.test(byId.http500.detail));
  /* THE ONE THAT MATTERS: a 200 is not a send. */
  ok("a 200 carrying a JSON-RPC error is a REFUSAL, not a landed send",
    byId.rpcerror.ok === false && /rate limited/.test(byId.rpcerror.detail), byId.rpcerror.detail);
  ok("a thrown connection is a failure, not an exception out of submit()",
    byId.boom.ok === false && /connection refused/.test(byId.boom.detail));
  ok("a 200 whose body will not parse is a success with no signature, never a crash",
    byId.garbage.ok === true && byId.garbage.signature === null);
  ok("the fastest accepting relay is named", report.firstOkId !== null, `${report.firstOkId} at ${report.firstOkMs}`);
  const s = sub.stats();
  ok("the counters split accepted from refused",
    s.submissions === 1 && s.relayAttempts === 6 && s.relayOk + s.relayFailed === 6, JSON.stringify(s));
}

console.log("\nwith no relays configured it is a no-op, which is every install today");
{
  const sub = createRelaySubmitter({ relays: [] });
  const report = await sub.submit("BYTES");
  ok("it attempts nothing and returns a report anyway",
    report.attempted === 0 && report.firstOkId === null && Array.isArray(report.results));
  ok("...and never throws", true);
}

console.log("\nevery relay failing is still not an exception");
{
  const sub = createRelaySubmitter({
    relays: [{ id: "a", url: "https://a.example" }, { id: "b", url: "https://b.example" }],
    fetchImpl: async () => { throw new Error("everything is down"); },
  });
  let raised = null;
  let report = null;
  try { report = await sub.submit("BYTES"); } catch (e) { raised = e; }
  ok("submit resolves", raised === null, raised?.message);
  ok("...reporting both failures, with no winner",
    report.attempted === 2 && report.firstOkId === null && report.results.every((r) => r.ok === false));
}

console.log("\nthe module itself holds no key, no address and no endpoint");
{
  const src = fs.readFileSync(new URL("./snipe-relay.mjs", import.meta.url), "utf8");
  ok("it never signs", !/Keypair|secretKey|\.sign\(/.test(src));
  /* No base58-looking constant anywhere: a tip address in a repo is money at an address
     nobody checked. The only long base58 strings allowed here are in a regex. */
  const constants = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  ok("it ships no tip address", !/["'][1-9A-HJ-NP-Za-km-z]{32,44}["']/.test(constants));
  ok("it ships no relay endpoint", !/https:\/\/(?!a\.example|b\.example)[a-z0-9.-]+\.[a-z]{2,}/i.test(constants));
  ok("it opens no Connection of its own", !src.includes("new Connection"));
}

console.log("\nwired into the send path, or it is a module nobody calls");
{
  const exec = fs.readFileSync(new URL("./snipe-execute.mjs", import.meta.url), "utf8");
  ok("the executor takes the submitter as a port", /relaySubmitter = null,/.test(exec));
  /* THE TIP MUST BE INSIDE THE SIGNED MESSAGE. Added afterwards it is not paid; in its
     own transaction it is not paid either. */
  const build = exec.slice(exec.indexOf("async function buildTransaction"), exec.indexOf("async function buildTransaction") + 900);
  ok("the tip is compiled into the message that gets signed",
    /\.\.\.\(tip \? \[tip\.instruction\] : \[\]\)/.test(build));
  ok("...LAST, so the simulation that follows covers its lamports",
    build.indexOf("tip.instruction") > build.indexOf("...instructions"));
  ok("the tip rides on the BUY only — nobody is bidding to be the one who sells",
    /const tip = side === "buy" \? tipFor\(\{ contention \}\) : null;/.test(exec));
  ok("a refused tip is a log line, never a refused trade",
    /sending untipped/.test(exec));
  ok("the tip lands on the durable record, because it is money that left the wallet",
    /tipLamports: tip\.lamports, tipAccount: tip\.to/.test(exec));
  /* THE FAN-OUT MUST NOT BE ABLE TO DELAY OR FAIL THE ORDINARY SEND. */
  ok("the relay submission is started BEFORE the RPC sends are awaited",
    exec.indexOf("const relayPromise") < exec.indexOf("const sends = await Promise.allSettled"));
  ok("...and its rejection is swallowed, so it can never fail a send",
    /relaySubmitter\.submit\(Buffer\.from\(bytes\)\.toString\("base64"\)\)\.catch\(\(\) => null\)/.test(exec));
  ok("with no submitter the path is exactly what it was",
    /relaySubmitter && typeof relaySubmitter\.submit === "function"/.test(exec));

  const poller = fs.readFileSync(new URL("./poller.mjs", import.meta.url), "utf8");
  ok("the poller reads both lists from the environment",
    /relaysFromEnv\(process\.env\)/.test(poller) && /tipAccountsFromEnv\(process\.env\)/.test(poller));
  ok("...and builds no submitter at all when none are configured",
    /snipeRelays\.length\s*\?\s*createRelaySubmitter/.test(poller));
  ok("...passing both to the executor", /relaySubmitter: snipeRelaySubmitter,/.test(poller)
    && /tipAccounts: snipeTipAccounts,/.test(poller));

  const runner = fs.readFileSync(new URL("./launchd-runner.mjs", import.meta.url), "utf8");
  for (const key of ["SNIPE_RELAYS", "SNIPE_TIP_ACCOUNTS", "SNIPE_TIP_BASE_LAMPORTS", "SNIPE_TIP_MAX_LAMPORTS"])
    ok(`${key} reaches the process — an unallowlisted key aborts the whole env file`,
      new RegExp(`"${key}"`).test(runner));
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} test-snipe-relay  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
