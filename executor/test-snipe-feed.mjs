/* THE LAUNCH FEED, DRIVEN ENTIRELY OFFLINE AGAINST AN INJECTED FAKE TRANSPORT.
 *
 * Not one line of this file opens a socket, resolves a hostname or waits on a real timer.
 * The transport, the clock and the scheduler are all injected, which is the only way to
 * assert the things that actually matter here — that a notice seen by two sources is
 * emitted once, that the first arrival's stamp survives, that a dead source is NAMED —
 * without a network whose behaviour would be the thing under test.
 *
 * THE FOUR CLAIMS THE TASK ASKS FOR, and where each is proved:
 *   · dedupe by mint                      — §3 (ledger), §6 (feed), §8 (200-arrival storm)
 *   · multi-source timing                 — §2 (merge), §6 (feed), §7 (the latency table)
 *   · a dead source is reported           — §9, and §10 for every source dead at once
 *   · nothing is emitted twice            — §6, §8, and the overflow case in §11
 *
 * AND THE DISCIPLINE THE REST OF THIS SUITE USES. Every ruler is run against a case whose
 * answer was worked out before the code did: a 32-byte key that IS a mint and a 31-byte
 * one that is not; slot 0, which a naive `!slot` check silently rejects; a silence of
 * 59,999 ms that must still read live next to one of 60,000 ms that must not. Both
 * failure directions are asserted throughout — a feed that says yes to everything and a
 * feed that says no to everything are equally useless — and every assertion prints the
 * value it actually saw.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import bs58 from "bs58";
import {
  SNIPE_FEED_VERSION, FEED_DEFAULTS, FEED_SOURCE_KINDS, FEED_REJECT_REASONS,
  FeedConfigError, isPlausibleMint, epochMsOf,
  stampArrival, openNoticeRecord, mergeArrival, createNoticeLedger,
  classifySource, summarizeFeedHealth, sourceLatency,
  createSnipeFeed, logsSubscribeSource, pollSource, sourceFromVenueWatch,
  web3LogsTransport, pumpfunRowToNotice, pumpfunListingFetcher, PUMPFUN_PAGE_ROWS,
} from "./snipe-feed.mjs";
import { REQUIRED_VENUE_METHODS } from "./snipe-venue.mjs";

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); console.log("  ok   ", name); pass++; }
  catch (error) { console.log("  FAIL ", name, "\n         ", error.message); fail++; }
};
const flush = () => new Promise((resolve) => setImmediate(resolve));

/* ── fixtures: keys whose byte length is known before the test runs ─────────────────── */

const mintOf = (byte) => bs58.encode(Buffer.alloc(32, byte));
const M1 = mintOf(0x11), M2 = mintOf(0x22), M3 = mintOf(0x33), M4 = mintOf(0x44);
const CREATOR = mintOf(0x55);
const PUMPFUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";   // src/data/solana.js:171
const SHORT_KEY = bs58.encode(Buffer.alloc(31, 0x11));                   // 31 bytes: not a key
const ZERO_KEY = bs58.encode(Buffer.alloc(32, 0));                       // the system program

/** A fake RPC-websocket transport. Counts every subscribe and unsubscribe, can refuse to
 *  connect, and hands notifications to the source on demand — the whole socket, in 20
 *  lines, entirely under the test's control. */
function fakeTransport() {
  const t = {
    subscribes: 0, unsubscribes: 0, live: 0, refuse: null, handlers: [],
    subscribe({ programId, commitment, onNotice, onError }) {
      t.subscribes++;
      if (t.refuse) throw new Error(t.refuse);
      t.live++;
      const handler = { programId, commitment, onNotice, onError };
      t.handlers.push(handler);
      return { unsubscribe() { t.unsubscribes++; t.live--; t.handlers = t.handlers.filter((h) => h !== handler); } };
    },
    push(notification, context) { for (const h of [...t.handlers]) h.onNotice(notification, context); },
    breakIt(message) { for (const h of [...t.handlers]) h.onError(new Error(message)); },
  };
  return t;
}

/** A scheduler the test advances by hand. No real time passes anywhere in this file. */
function fakeTimers() {
  const tasks = new Map();
  let next = 0;
  return {
    schedule(fn, ms) { const id = ++next; tasks.set(id, { fn, ms }); return id; },
    cancel(id) { tasks.delete(id); },
    get pending() { return tasks.size; },
    async runAll() {
      const due = [...tasks.entries()];
      tasks.clear();
      for (const [, task] of due) await task.fn();
      await flush();
    },
  };
}

/* The clock every test reads. Set it, then act — so an arrival stamp is a value this file
   chose, and a latency below is arithmetic the reader can check by eye. */
let NOW = 1_000_000;
const clock = () => NOW;

const pumpRow = (mint, createdSeconds) => ({
  mint, creator: CREATOR, created_timestamp: createdSeconds, name: "fixture", symbol: "FIX",
});

console.log(`\n══ snipe-feed: ${SNIPE_FEED_VERSION} ══`);

/* ── §1 the arrival stamp, against known answers ───────────────────────────────────── */

console.log("\n1. THE ARRIVAL STAMP");

await ok("a well-formed notice is stamped with our clock, and the payload's clock is kept apart", () => {
  const r = stampArrival({ mint: M1, creator: CREATOR, slot: 300_000_001, source: "logs", kind: "logs",
    arrivedAtMs: 1_000_500, originAtMs: 1_000_000, raw: { a: 1 } });
  assert.equal(r.ok, true, `stampArrival refused a good notice: ${r.message}`);
  const a = r.arrival;
  assert.equal(a.arrivedAtMs, 1_000_500, `arrivedAtMs = ${a.arrivedAtMs}`);
  assert.equal(a.originAtMs, 1_000_000, `originAtMs = ${a.originAtMs}`);
  assert.equal(a.originLagMs, 500, `originLagMs = ${a.originLagMs}`);
  assert.equal(a.crossClock, true, "an origin claim must be labelled cross-clock");
  assert.equal(Object.isFrozen(a), true, "the arrival must be frozen");
  console.log(`         arrivedAtMs 1000500 (ours) · originAtMs 1000000 (theirs) · originLagMs ${a.originLagMs} crossClock=${a.crossClock}`);
});

await ok("the mint ruler: 32 bytes yes, 31 bytes no, 32 zero bytes no, garbage no", () => {
  assert.equal(isPlausibleMint(M1), true, `a 32-byte key was refused: ${M1}`);
  assert.equal(isPlausibleMint(PUMPFUN_PROGRAM), true, "the pump.fun program id is 32 bytes and must read as a key");
  assert.equal(isPlausibleMint(SHORT_KEY), false, `a ${bs58.decode(SHORT_KEY).length}-byte key was accepted`);
  assert.equal(isPlausibleMint(ZERO_KEY), false, "32 zero bytes is the system program, never a mint");
  assert.equal(isPlausibleMint("0OIl-not-base58"), false, "non-base58 accepted");
  assert.equal(isPlausibleMint(""), false);
  assert.equal(isPlausibleMint(null), false);
  console.log(`         32B=${isPlausibleMint(M1)} 31B=${isPlausibleMint(SHORT_KEY)} zero32=${isPlausibleMint(ZERO_KEY)} junk=${isPlausibleMint("0OIl-not-base58")}`);
});

await ok("a bad mint is refused by name, and a good one is not", () => {
  for (const [bad, label] of [[SHORT_KEY, "31 bytes"], [ZERO_KEY, "32 zero bytes"], [undefined, "absent"], [12, "a number"]]) {
    const r = stampArrival({ mint: bad, source: "s", kind: "logs", arrivedAtMs: 1 });
    assert.equal(r.ok, false, `${label} was accepted as a mint`);
    assert.equal(r.reason, "mint_invalid", `${label} refused as ${r.reason}, expected mint_invalid`);
  }
  assert.equal(stampArrival({ mint: M1, source: "s", kind: "logs", arrivedAtMs: 1 }).ok, true,
    "the ruler must be able to say yes");
  console.log(`         refused: 31 bytes, 32 zero bytes, absent, a number — accepted: a real 32-byte mint`);
});

await ok("slot 0 is a slot; 1.5, -1 and \"12\" are not; null is allowed and means no slot", () => {
  const zero = stampArrival({ mint: M1, slot: 0, source: "s", kind: "logs", arrivedAtMs: 1 });
  assert.equal(zero.ok, true, "slot 0 was refused — the exact value a `!slot` check drops");
  assert.equal(zero.arrival.slot, 0, `slot = ${zero.arrival.slot}`);
  for (const bad of [1.5, -1, "12", NaN, Infinity]) {
    const r = stampArrival({ mint: M1, slot: bad, source: "s", kind: "logs", arrivedAtMs: 1 });
    assert.equal(r.ok, false, `slot ${JSON.stringify(bad)} was accepted`);
    assert.equal(r.reason, "slot_invalid", `slot ${JSON.stringify(bad)} refused as ${r.reason}`);
  }
  assert.equal(stampArrival({ mint: M1, slot: null, source: "s", kind: "logs", arrivedAtMs: 1 }).arrival.slot, null);
  console.log(`         slot 0 accepted · 1.5 / -1 / "12" / NaN / Infinity refused as slot_invalid · null = no slot`);
});

await ok("a bad kind and a bad arrival stamp are each refused by their own name", () => {
  assert.equal(stampArrival({ mint: M1, source: "s", kind: "ws", arrivedAtMs: 1 }).reason, "kind_invalid");
  assert.equal(stampArrival({ mint: M1, source: "s", kind: "logs", arrivedAtMs: NaN }).reason, "arrival_invalid");
  assert.equal(stampArrival({ mint: M1, source: "s", kind: "logs", arrivedAtMs: -1 }).reason, "arrival_invalid");
  assert.equal(stampArrival({ mint: M1, source: "", kind: "logs", arrivedAtMs: 1 }).reason, "payload_invalid");
  for (const reason of ["kind_invalid", "arrival_invalid", "payload_invalid", "mint_invalid", "slot_invalid"])
    assert.ok(FEED_REJECT_REASONS.includes(reason), `${reason} is not in FEED_REJECT_REASONS`);
  console.log(`         kinds are ${FEED_SOURCE_KINDS.join("/")}; every reason used is in FEED_REJECT_REASONS (${FEED_REJECT_REASONS.length})`);
});

await ok("an unreadable deployer does not void the launch, and is never quietly nulled", () => {
  const r = stampArrival({ mint: M1, creator: "not-a-key", source: "s", kind: "logs", arrivedAtMs: 1 });
  assert.equal(r.ok, true, "a bad creator voided a real launch notice");
  assert.equal(r.arrival.creator, null, `creator = ${r.arrival.creator}`);
  assert.equal(r.arrival.creatorInvalid, true, "the flag that stops CREATOR-SOLD reading `no deployer` is missing");
  assert.equal(r.arrival.creatorClaim, "not-a-key", `the claim was discarded: ${r.arrival.creatorClaim}`);
  const good = stampArrival({ mint: M1, creator: CREATOR, source: "s", kind: "logs", arrivedAtMs: 1 }).arrival;
  assert.equal(good.creatorInvalid, false, "a valid creator was flagged invalid");
  console.log(`         bad creator: creator=null creatorInvalid=true claim kept · good creator: creatorInvalid=${good.creatorInvalid}`);
});

await ok("seconds and milliseconds epochs are both read as what they are", () => {
  assert.equal(epochMsOf(1_757_000_000), 1_757_000_000_000, `seconds epoch = ${epochMsOf(1_757_000_000)}`);
  assert.equal(epochMsOf(1_757_000_000_000), 1_757_000_000_000);
  assert.equal(epochMsOf(0), null);
  assert.equal(epochMsOf("nope"), null);
  console.log(`         1757000000 -> ${epochMsOf(1_757_000_000)} ms (a seconds epoch read raw is a coin 1.6 years old)`);
});

/* ── §2 first arrival wins, and both timing directions ─────────────────────────────── */

console.log("\n2. MULTI-SOURCE TIMING — FIRST ARRIVAL WINS");

const arrivalOf = (over) => stampArrival({ mint: M1, source: "A", kind: "logs", arrivedAtMs: 1000, slot: 100, ...over }).arrival;

await ok("a second source is appended with its own lag and slot delta; the first stamp is untouched", () => {
  const first = openNoticeRecord(arrivalOf({}));
  const merged = mergeArrival(first, arrivalOf({ source: "B", kind: "poll", arrivedAtMs: 1350, slot: 103 }));
  assert.equal(merged.firstSource, "A", `firstSource = ${merged.firstSource}`);
  assert.equal(merged.firstSeenAtMs, 1000, `firstSeenAtMs = ${merged.firstSeenAtMs}`);
  assert.equal(merged.firstSlot, 100, `firstSlot = ${merged.firstSlot}`);
  assert.equal(merged.sources.length, 2, `sources = ${merged.sources.length}`);
  assert.equal(merged.sources[1].lagMsFromFirst, 350, `B lag = ${merged.sources[1].lagMsFromFirst}ms`);
  assert.equal(merged.sources[1].slotsBehindFirst, 3, `B slot delta = ${merged.sources[1].slotsBehindFirst}`);
  assert.equal(merged.corroborations, 1, `corroborations = ${merged.corroborations}`);
  console.log(`         A@1000 slot100 first · B@1350 slot103 -> lag ${merged.sources[1].lagMsFromFirst}ms, ${merged.sources[1].slotsBehindFirst} slots behind`);
});

await ok("merge does not mutate the record it is handed", () => {
  const first = openNoticeRecord(arrivalOf({}));
  const before = JSON.stringify(first);
  const merged = mergeArrival(first, arrivalOf({ source: "B", arrivedAtMs: 1350, slot: 103 }));
  assert.notEqual(merged, first, "mergeArrival returned the same object");
  assert.equal(JSON.stringify(first), before, "the original record changed under the caller");
  assert.equal(first.sources.length, 1, `original sources = ${first.sources.length}`);
  assert.equal(Object.isFrozen(merged) && Object.isFrozen(merged.sources), true, "the merged record must be frozen");
  console.log(`         original still has ${first.sources.length} leg; the merge returned a new frozen record with ${merged.sources.length}`);
});

await ok("a source with no slot reports slotsBehindFirst = null, never 0", () => {
  const first = openNoticeRecord(arrivalOf({}));
  const merged = mergeArrival(first, arrivalOf({ source: "poll", kind: "poll", arrivedAtMs: 1400, slot: null }));
  assert.equal(merged.sources[1].slotsBehindFirst, null,
    `a slotless poll row reported ${merged.sources[1].slotsBehindFirst} slots behind — that is a fabricated measurement`);
  assert.equal(merged.sources[1].lagMsFromFirst, 400, `poll lag = ${merged.sources[1].lagMsFromFirst}`);
  console.log(`         poll leg: lag ${merged.sources[1].lagMsFromFirst}ms, slotsBehindFirst=${merged.sources[1].slotsBehindFirst} (it carries no slot and says so)`);
});

await ok("a backwards clock is REPORTED as a negative lag, not clamped to a flattering zero", () => {
  const first = openNoticeRecord(arrivalOf({}));
  const clean = mergeArrival(first, arrivalOf({ source: "B", arrivedAtMs: 1200, slot: 101 }));
  assert.equal(clean.clockRegression, false, "a normal merge must not raise the fault flag");
  const bad = mergeArrival(first, arrivalOf({ source: "B", arrivedAtMs: 900, slot: 101 }));
  assert.equal(bad.sources[1].lagMsFromFirst, -100, `lag = ${bad.sources[1].lagMsFromFirst} (a clamp would read 0 — the feed's best-ever latency, at the moment its ruler broke)`);
  assert.equal(bad.clockRegression, true, "clockRegression was not raised");
  assert.equal(bad.firstSeenAtMs, 1000, `firstSeenAtMs moved to ${bad.firstSeenAtMs}`);
  assert.equal(bad.firstSource, "A", `firstSource moved to ${bad.firstSource}`);
  console.log(`         clean merge clockRegression=${clean.clockRegression} · backwards merge lag ${bad.sources[1].lagMsFromFirst}ms, flag=${bad.clockRegression}, first still A@${bad.firstSeenAtMs}`);
});

await ok("a later source may FILL IN a missing deployer but may never overwrite one", () => {
  const blind = openNoticeRecord(arrivalOf({ creator: null }));
  const filled = mergeArrival(blind, arrivalOf({ source: "poll", kind: "poll", arrivedAtMs: 1400, creator: CREATOR }));
  assert.equal(filled.creator, CREATOR, `creator = ${filled.creator}`);
  const known = openNoticeRecord(arrivalOf({ creator: CREATOR }));
  const other = mergeArrival(known, arrivalOf({ source: "poll", kind: "poll", arrivedAtMs: 1400, creator: mintOf(0x66) }));
  assert.equal(other.creator, CREATOR, `a second source overwrote the deployer with ${other.creator}`);
  console.log(`         null -> filled from the poll leg; a conflicting later claim was ignored (first arrival wins)`);
});

await ok("merging across mints throws rather than silently joining two launches", () => {
  const first = openNoticeRecord(arrivalOf({}));
  assert.throws(() => mergeArrival(first, arrivalOf({ mint: M2 })), /across mints/);
  console.log(`         mergeArrival(M1-record, M2-arrival) throws`);
});

/* ── §3 dedupe ─────────────────────────────────────────────────────────────────────── */

console.log("\n3. DEDUPE BY MINT");

await ok("one mint from two sources, admitted six times, is fresh exactly once", () => {
  const ledger = createNoticeLedger();
  const verdicts = [];
  for (let i = 0; i < 6; i++)
    verdicts.push(ledger.admit(arrivalOf({ source: i % 2 ? "B" : "A", arrivedAtMs: 1000 + i * 10, slot: 100 + i }), 1000 + i * 10).fresh);
  assert.deepEqual(verdicts, [true, false, false, false, false, false], `fresh verdicts were ${JSON.stringify(verdicts)}`);
  const record = ledger.get(M1);
  assert.equal(record.sources.length, 6, `legs = ${record.sources.length}`);
  assert.equal(record.firstSeenAtMs, 1000, `firstSeenAtMs = ${record.firstSeenAtMs}`);
  assert.equal(ledger.stats().fresh, 1, `stats.fresh = ${ledger.stats().fresh}`);
  assert.equal(ledger.stats().corroborated, 5, `stats.corroborated = ${ledger.stats().corroborated}`);
  console.log(`         6 admits -> fresh 1, corroborated 5, ${record.sources.length} legs on one record`);
});

await ok("three mints across two sources: three fresh, and the ledger holds three", () => {
  const ledger = createNoticeLedger();
  let fresh = 0;
  for (const mint of [M1, M2, M3, M1, M2, M3, M1])
    for (const source of ["A", "B"])
      if (ledger.admit(arrivalOf({ mint, source, arrivedAtMs: 2000, slot: 200 }), 2000).fresh) fresh++;
  assert.equal(fresh, 3, `fresh = ${fresh} over 14 admits of 3 mints`);
  assert.equal(ledger.size, 3, `ledger size = ${ledger.size}`);
  console.log(`         14 admits of 3 mints -> fresh ${fresh}, ledger size ${ledger.size}`);
});

await ok("eviction is bounded AND flagged — a returning mint is never a silent second launch", () => {
  const ledger = createNoticeLedger({ capacity: 2, ttlMs: 0 });
  for (const mint of [M1, M2, M3]) ledger.admit(arrivalOf({ mint, arrivedAtMs: 3000 }), 3000);
  assert.equal(ledger.size, 2, `size = ${ledger.size} at capacity 2`);
  assert.equal(ledger.has(M1), false, "the oldest mint should have been evicted");
  assert.equal(ledger.get(M3).reemittedAfterEviction, false, "a never-evicted mint must not carry the flag");
  const again = ledger.admit(arrivalOf({ mint: M1, arrivedAtMs: 3100 }), 3100);
  assert.equal(again.fresh, true, "a returning mint must be admitted — refusing it drops a live launch");
  assert.equal(again.record.reemittedAfterEviction, true, "the re-emission was not flagged");
  assert.equal(ledger.stats().reemitted, 1, `stats.reemitted = ${ledger.stats().reemitted}`);
  assert.ok(ledger.stats().evicted >= 1, `stats.evicted = ${ledger.stats().evicted}`);
  console.log(`         capacity 2, 3 mints -> evicted ${ledger.stats().evicted}; M1 returns fresh=true flagged reemittedAfterEviction=true`);
});

await ok("the ttl window expires old rows, and does not expire rows inside it", () => {
  const ledger = createNoticeLedger({ capacity: 100, ttlMs: 1_000 });
  ledger.admit(arrivalOf({ mint: M1, arrivedAtMs: 5_000 }), 5_000);
  ledger.admit(arrivalOf({ mint: M2, arrivedAtMs: 5_500 }), 5_500);
  assert.equal(ledger.size, 2, `size before expiry = ${ledger.size}`);
  ledger.prune(6_100);                                  // M1 is 1100ms old, M2 is 600ms old
  assert.equal(ledger.has(M1), false, "a row past the ttl survived");
  assert.equal(ledger.has(M2), true, "a row inside the ttl was expired");
  assert.equal(ledger.stats().expired, 1, `stats.expired = ${ledger.stats().expired}`);
  console.log(`         ttl 1000ms at t=6100: M1 (age 1100) expired, M2 (age 600) kept · default ttl ${FEED_DEFAULTS.dedupeTtlMs}ms`);
});

/* ── §4 health classification ──────────────────────────────────────────────────────── */

console.log("\n4. HEALTH, CLASSIFIED ON BOTH SIDES OF EVERY THRESHOLD");

const sourceState = (over) => ({ id: "logs", kind: "logs", state: "live", startedAtMs: 0,
  lastNoticeAtMs: 0, notices: 1, accepted: 1, firsts: 1, errors: 0, consecutiveErrors: 0, ...over });

await ok("silence: 59,999ms is live, 60,000ms is degraded, 300,000ms is dead", () => {
  const at = (ms) => classifySource(sourceState({ lastNoticeAtMs: 0 }), ms, FEED_DEFAULTS);
  assert.equal(at(59_999).state, "live", `59999ms read as ${at(59_999).state}`);
  assert.equal(at(60_000).state, "degraded", `60000ms read as ${at(60_000).state}`);
  assert.equal(at(299_999).state, "degraded", `299999ms read as ${at(299_999).state}`);
  assert.equal(at(300_000).state, "dead", `300000ms read as ${at(300_000).state}`);
  assert.match(at(300_000).reason, /silent 300000ms/, `dead reason was "${at(300_000).reason}"`);
  console.log(`         59999->live 60000->degraded 299999->degraded 300000->dead ("${at(300_000).reason}")`);
});

await ok("a source that started and never spoke is measured from its start, not exempted", () => {
  const never = classifySource(sourceState({ lastNoticeAtMs: null, startedAtMs: 0 }), 400_000, FEED_DEFAULTS);
  assert.equal(never.state, "dead", `a socket that never delivered read as ${never.state}`);
  assert.equal(never.silentMs, 400_000, `silentMs = ${never.silentMs}`);
  const unstarted = classifySource(sourceState({ lastNoticeAtMs: null, startedAtMs: null, state: "starting" }), 400_000, FEED_DEFAULTS);
  assert.equal(unstarted.state, "starting", `an unstarted source read as ${unstarted.state}`);
  console.log(`         started+silent 400000ms -> dead · never started -> starting (not dead, and not live)`);
});

await ok("errors: 4 consecutive is degraded, 5 is dead, 0 is live", () => {
  const at = (n) => classifySource(sourceState({ consecutiveErrors: n, errors: n }), 1_000, FEED_DEFAULTS);
  assert.equal(at(0).state, "live", `0 errors read as ${at(0).state}`);
  assert.equal(at(4).state, "degraded", `4 errors read as ${at(4).state}`);
  assert.equal(at(5).state, "dead", `5 errors read as ${at(5).state}`);
  console.log(`         0->live 4->degraded 5->dead (maxConsecutiveErrors ${FEED_DEFAULTS.maxConsecutiveErrors})`);
});

await ok("a fatal source is dead immediately and carries its error text", () => {
  const dead = classifySource(sourceState({ fatal: true, lastError: "websocket refused: ECONNREFUSED" }), 1_000, FEED_DEFAULTS);
  assert.equal(dead.state, "dead", `fatal source read as ${dead.state}`);
  assert.match(dead.reason, /ECONNREFUSED/, `reason lost the error: "${dead.reason}"`);
  console.log(`         fatal -> dead, reason "${dead.reason}"`);
});

await ok("the feed summary names the dead source, and is not ok when none is live", () => {
  const mixed = summarizeFeedHealth([sourceState({ id: "logs" }), sourceState({ id: "poll", fatal: true, lastError: "boom" })], 1_000, FEED_DEFAULTS);
  assert.equal(mixed.ok, true, "one live source is still a working feed");
  assert.equal(mixed.state, "degraded", `state = ${mixed.state}`);
  assert.deepEqual([...mixed.dead], ["poll"], `dead = ${JSON.stringify(mixed.dead)}`);
  assert.match(mixed.message, /DEAD: poll/, `message = "${mixed.message}"`);
  const blind = summarizeFeedHealth([sourceState({ id: "logs", fatal: true, lastError: "a" }), sourceState({ id: "poll", fatal: true, lastError: "b" })], 1_000, FEED_DEFAULTS);
  assert.equal(blind.ok, false, "a feed with no live source reported ok");
  assert.equal(blind.state, "dead", `state = ${blind.state}`);
  console.log(`         one dead: ok=${mixed.ok} "${mixed.message}" · all dead: ok=${blind.ok} state=${blind.state}`);
});

/* ── §5 the latency table refuses the cross-clock number ───────────────────────────── */

console.log("\n5. THE LATENCY TABLE");

await ok("lags are medianed over corroborated mints; a never-beaten source reports null, not 0ms", () => {
  const records = [100, 300, 500].map((lag, i) => {
    const first = openNoticeRecord(arrivalOf({ mint: [M1, M2, M3][i], source: "logs", arrivedAtMs: 1000, slot: 100 }));
    return mergeArrival(first, arrivalOf({ mint: [M1, M2, M3][i], source: "poll", kind: "poll", arrivedAtMs: 1000 + lag, slot: 102 }));
  });
  const table = sourceLatency(records);
  const logs = table.sources.find((s) => s.id === "logs");
  const poll = table.sources.find((s) => s.id === "poll");
  assert.equal(logs.firsts, 3, `logs firsts = ${logs.firsts}`);
  assert.equal(logs.lagSamples, 0, `logs lagSamples = ${logs.lagSamples}`);
  assert.equal(logs.minLagMs, null, `a source that was never beaten reported ${logs.minLagMs}ms — no samples is not "0ms behind"`);
  assert.equal(poll.medianLagMs, 300, `poll median lag = ${poll.medianLagMs} (median of 100/300/500 is 300)`);
  assert.equal(poll.minLagMs, 100, `poll min = ${poll.minLagMs}`);
  assert.equal(poll.maxLagMs, 500, `poll max = ${poll.maxLagMs}`);
  assert.equal(poll.medianSlotsBehind, 2, `poll median slots behind = ${poll.medianSlotsBehind}`);
  assert.equal(table.corroborated, 3, `corroborated = ${table.corroborated}`);
  console.log(`         logs firsts ${logs.firsts}/${logs.arrivals} lag n/a · poll median ${poll.medianLagMs}ms (min ${poll.minLagMs}, max ${poll.maxLagMs}), ${poll.medianSlotsBehind} slots behind`);
});

await ok("the cross-clock originLag is NOT what ranks the sources", () => {
  /* One record whose poll leg claims an origin 9,000,000ms before it arrived — the shape a
     clock-skewed web server produces. The measured lag is 400ms and must stay 400ms. */
  const first = openNoticeRecord(arrivalOf({ source: "logs", arrivedAtMs: 1_000_000, slot: 100 }));
  const merged = mergeArrival(first, arrivalOf({ source: "poll", kind: "poll", arrivedAtMs: 1_000_400,
    slot: null, originAtMs: 1 }));
  assert.equal(merged.sources[1].crossClock, true, "the origin claim was not labelled");
  assert.ok(merged.sources[1].originLagMs > 900_000, `originLagMs = ${merged.sources[1].originLagMs}`);
  const table = sourceLatency([merged]);
  const poll = table.sources.find((s) => s.id === "poll");
  assert.equal(poll.medianLagMs, 400, `the table used the cross-clock number: ${poll.medianLagMs}ms`);
  assert.equal(table.measuredOnCorroboratedOnly, true, "the caveat must travel with the table");
  console.log(`         originLagMs ${merged.sources[1].originLagMs} (two clocks) ignored; table reports ${poll.medianLagMs}ms (one clock, twice)`);
});

/* ── §6 the feed, offline, end to end ──────────────────────────────────────────────── */

console.log("\n6. THE FEED — TWO LIVE SOURCES, NO NETWORK");

const transport = fakeTransport();
const timers = fakeTimers();
let pollRows = [];

await ok("nothing subscribes at import, and nothing subscribes at construction", () => {
  assert.equal(transport.subscribes, 0, `${transport.subscribes} subscribe(s) before start()`);
  assert.equal(timers.pending, 0, `${timers.pending} timer(s) before start()`);
  console.log(`         after import + fixtures: subscribes ${transport.subscribes}, timers ${timers.pending}`);
});

const logs = logsSubscribeSource({
  id: "logs", venueId: "pumpfun", programId: PUMPFUN_PROGRAM, transport,
  /* The parser is the ADAPTER's, never this module's: no venue log layout is verified in
     this repo. Here it is a fixture that reads a field the fake transport puts there. */
  extractMint: (notification) => (notification?.create ? { mint: notification.create, creator: notification.creator ?? null } : null),
});
const poll = pollSource({ id: "poll", venueId: "pumpfun", fetchRows: async () => pollRows, intervalMs: 5_000 });

const feed = createSnipeFeed({ sources: [logs, poll], clock, schedule: timers.schedule, cancel: timers.cancel,
  cfg: { maxQueued: 64 } });

const received = [];
const consumer = (async () => { for await (const record of feed.notices()) received.push(record); })();

await ok("start() opens exactly one subscription and one poll timer, and reports both live", async () => {
  assert.equal(transport.subscribes, 0, "construction subscribed");
  const summary = await feed.start();
  assert.equal(transport.subscribes, 1, `subscribes = ${transport.subscribes}`);
  assert.equal(transport.live, 1, `live subscriptions = ${transport.live}`);
  assert.equal(timers.pending, 1, `pending timers = ${timers.pending}`);
  assert.deepEqual([...summary.started], ["logs", "poll"], `started = ${JSON.stringify(summary.started)}`);
  assert.equal(summary.failed.length, 0, `failed = ${JSON.stringify(summary.failed)}`);
  assert.equal(summary.health.ok, true, `health.ok = ${summary.health.ok}`);
  console.log(`         started ${summary.started.join(", ")} · subscribes ${transport.subscribes} · timers ${timers.pending} · "${summary.health.message}"`);
});

await ok("the socket sees M1 first; the poll sees M1 and M2 later — two emissions, three arrivals", async () => {
  NOW = 1_000_000;
  transport.push({ create: M1, creator: CREATOR }, { slot: 300_000_100 });
  await flush();
  NOW = 1_000_400;
  pollRows = [pumpRow(M1, 1_000), pumpRow(M2, 1_000)];
  await timers.runAll();

  assert.equal(received.length, 2, `emitted ${received.length} records for 3 arrivals of 2 mints`);
  const m1 = feed.record(M1);
  assert.equal(m1.firstSource, "logs", `M1 firstSource = ${m1.firstSource}`);
  assert.equal(m1.firstSeenAtMs, 1_000_000, `M1 firstSeenAtMs = ${m1.firstSeenAtMs}`);
  assert.equal(m1.firstSlot, 300_000_100, `M1 firstSlot = ${m1.firstSlot}`);
  assert.equal(m1.sources.length, 2, `M1 legs = ${m1.sources.length}`);
  assert.equal(m1.sources[1].source, "poll", `M1 second leg = ${m1.sources[1].source}`);
  assert.equal(m1.sources[1].lagMsFromFirst, 400, `poll was ${m1.sources[1].lagMsFromFirst}ms behind the socket`);
  assert.equal(m1.sources[1].slotsBehindFirst, null, "a poll row has no slot and must not invent one");
  assert.equal(feed.record(M2).firstSource, "poll", `M2 firstSource = ${feed.record(M2).firstSource}`);
  console.log(`         M1: logs@${m1.firstSeenAtMs} slot ${m1.firstSlot} first, poll +${m1.sources[1].lagMsFromFirst}ms · M2: first seen by ${feed.record(M2).firstSource} · emissions ${received.length}`);
});

await ok("the same mint arriving again — from either source — emits nothing", async () => {
  const before = received.length;
  NOW = 1_000_900;
  transport.push({ create: M1, creator: CREATOR }, { slot: 300_000_130 });
  await flush();
  NOW = 1_001_400;
  await timers.runAll();                       // the poll re-lists M1 and M2, as a poll does
  assert.equal(received.length, before, `${received.length - before} extra emission(s) from re-arrivals`);
  const m1 = feed.record(M1);
  assert.equal(m1.sources.length, 4, `M1 legs = ${m1.sources.length}`);
  assert.equal(m1.firstSeenAtMs, 1_000_000, `firstSeenAtMs moved to ${m1.firstSeenAtMs}`);
  assert.equal(feed.stats().emitted, 2, `stats.emitted = ${feed.stats().emitted}`);
  assert.ok(feed.stats().corroborated >= 3, `stats.corroborated = ${feed.stats().corroborated}`);
  console.log(`         3 further arrivals -> emissions still ${received.length}, M1 now ${m1.sources.length} legs, corroborated ${feed.stats().corroborated}`);
});

await ok("the feed's own latency table reads off those records", () => {
  const table = feed.latency();
  const logsRow = table.sources.find((s) => s.id === "logs");
  const pollRow = table.sources.find((s) => s.id === "poll");
  assert.equal(logsRow.firsts, 1, `logs firsts = ${logsRow.firsts}`);
  assert.equal(pollRow.firsts, 1, `poll firsts = ${pollRow.firsts}`);
  assert.equal(pollRow.minLagMs, 400, `poll min lag = ${pollRow.minLagMs}`);
  assert.equal(pollRow.negativeLags, 0, `negative lags = ${pollRow.negativeLags}`);
  console.log(`         logs: ${logsRow.firsts} first of ${logsRow.arrivals} · poll: ${pollRow.firsts} first of ${pollRow.arrivals}, min lag ${pollRow.minLagMs}ms, median ${pollRow.medianLagMs}ms`);
});

await ok("an unrecognised notification is counted, not dropped — and still proves the socket is alive", async () => {
  const before = feed.stats().rejected;
  NOW = 1_002_000;
  transport.push({ trade: "some other instruction" }, { slot: 300_000_140 });
  await flush();
  const stats = feed.stats();
  assert.equal(stats.rejected, before + 1, `rejected went ${before} -> ${stats.rejected}`);
  assert.equal(received.length, 2, `an unparsed notification emitted a record (${received.length})`);
  const logsHealth = feed.health(1_002_000).sources.find((s) => s.id === "logs");
  assert.equal(logsHealth.unparsed, 1, `unparsed = ${logsHealth.unparsed}`);
  assert.equal(logsHealth.lastNoticeAtMs, 1_002_000, `lastNoticeAtMs = ${logsHealth.lastNoticeAtMs}`);
  assert.equal(logsHealth.state, "live", `a socket delivering non-create traffic read as ${logsHealth.state}`);
  const sample = feed.rejections().find((r) => r.reason === "unparsed");
  assert.ok(sample, "the unparsed notification left no sample behind");
  console.log(`         unparsed ${logsHealth.unparsed}, emissions still ${received.length}, socket state ${logsHealth.state} (traffic is liveness)`);
});

await ok("a notice whose mint is not a mint is refused by name and never reaches the stream", async () => {
  NOW = 1_002_500;
  transport.push({ create: SHORT_KEY }, { slot: 300_000_150 });
  await flush();
  assert.equal(received.length, 2, `a 31-byte "mint" was emitted (${received.length} records)`);
  const sample = feed.rejections().find((r) => r.reason === "mint_invalid");
  assert.ok(sample, "no mint_invalid sample was kept");
  assert.match(sample.message, /is not a 32-byte base58 key/, `sample message = "${sample.message}"`);
  console.log(`         refused: ${sample.reason} — "${sample.message.slice(0, 72)}…"`);
});

await ok("stop() unsubscribes, cancels the poll timer and ends the stream", async () => {
  await feed.stop();
  assert.equal(transport.unsubscribes, 1, `unsubscribes = ${transport.unsubscribes}`);
  assert.equal(transport.live, 0, `live subscriptions after stop = ${transport.live}`);
  assert.equal(timers.pending, 0, `pending timers after stop = ${timers.pending}`);
  await consumer;                              // hangs forever if the stream did not close
  assert.equal(received.length, 2, `final emissions = ${received.length}`);
  const mints = received.map((r) => r.mint);
  assert.equal(new Set(mints).size, mints.length, `a mint was emitted twice: ${JSON.stringify(mints)}`);
  console.log(`         unsubscribes ${transport.unsubscribes}, timers ${timers.pending}, stream closed, ${mints.length} records, ${new Set(mints).size} distinct mints`);
});

/* ── §7 a storm: nothing is emitted twice ──────────────────────────────────────────── */

console.log("\n7. A STORM OF ARRIVALS, 4 MINTS, 2 SOURCES");

await ok("every mint is emitted exactly once, whichever source happened to be first", async () => {
  const t = fakeTransport();
  const clocks = fakeTimers();
  let rows = [];
  const f = createSnipeFeed({
    sources: [
      logsSubscribeSource({ id: "logs", programId: PUMPFUN_PROGRAM, transport: t,
        extractMint: (n) => (n?.create ? { mint: n.create } : null) }),
      pollSource({ id: "poll", fetchRows: async () => rows, intervalMs: 1_000 }),
    ],
    clock, schedule: clocks.schedule, cancel: clocks.cancel,
  });
  const got = [];
  const drain = (async () => { for await (const r of f.notices()) got.push(r); })();
  await f.start();

  const mints = [M1, M2, M3, M4];
  let arrivals = 0;
  NOW = 2_000_000;
  for (let i = 0; i < 100; i++) {
    NOW += 7;
    /* Deliberately interleaved so the "first" source differs per mint: M2 and M4 are seen
       by the poll before the socket ever mentions them. */
    const mint = mints[(i * 3) % 4];
    if (i % 2 === 0 && mint !== M2 && mint !== M4) { t.push({ create: mint }, { slot: 400_000 + i }); arrivals++; }
    rows = [pumpRow(mint, 2_000)];
    await clocks.runAll();
    arrivals++;
  }
  await flush();
  await f.stop();
  await drain;

  const seen = got.map((r) => r.mint);
  assert.equal(seen.length, new Set(seen).size, `duplicates in the stream: ${seen.length} records, ${new Set(seen).size} distinct`);
  assert.equal(new Set(seen).size, 4, `expected 4 launches, stream carried ${new Set(seen).size}`);
  assert.equal(f.stats().emitted, 4, `stats.emitted = ${f.stats().emitted}`);
  const firstBy = {};
  for (const r of got) firstBy[r.firstSource] = (firstBy[r.firstSource] ?? 0) + 1;
  assert.ok(firstBy.logs > 0 && firstBy.poll > 0, `both sources must have won at least one race: ${JSON.stringify(firstBy)}`);
  console.log(`         ${arrivals} arrivals -> ${seen.length} emissions, ${new Set(seen).size} distinct mints; first-source split ${JSON.stringify(firstBy)}`);
  console.log(`         corroborated ${f.stats().corroborated}, ledger ${JSON.stringify(f.stats().ledger.size)} rows`);
});

/* ── §8 backpressure refuses BEFORE the dedupe ─────────────────────────────────────── */

console.log("\n8. BACKPRESSURE");

await ok("an overflowed mint stays admissible — it is refused before the ledger sees it", async () => {
  const t = fakeTransport();
  const clocks = fakeTimers();
  const f = createSnipeFeed({ sources: [logsSubscribeSource({ id: "logs", programId: PUMPFUN_PROGRAM, transport: t,
    extractMint: (n) => (n?.create ? { mint: n.create } : null) })],
    clock, schedule: clocks.schedule, cancel: clocks.cancel, cfg: { maxQueued: 2 } });
  await f.start();                                    // no consumer attached: the queue fills

  NOW = 3_000_000;
  for (const mint of [M1, M2, M3]) { t.push({ create: mint }, { slot: 500_000 }); await flush(); }
  assert.equal(f.stats().queued, 2, `queued = ${f.stats().queued} at maxQueued 2`);
  assert.equal(f.stats().overflow, 1, `overflow = ${f.stats().overflow}`);
  assert.equal(f.record(M3), null, "the overflowed mint was admitted to the ledger and is now permanently invisible");
  assert.equal(f.stats().ledger.size, 2, `ledger size = ${f.stats().ledger.size}`);

  const heldAtOverflow = f.stats().ledger.size;
  const it = f.notices();
  const first = await it.next();                      // drain one, making room
  assert.equal(first.value.mint, M1, `drained ${first.value.mint}`);
  NOW = 3_000_100;
  t.push({ create: M3 }, { slot: 500_010 });
  await flush();
  assert.ok(f.record(M3), "the refused mint was not admissible on its next arrival — it would be lost forever");
  assert.equal(f.record(M3).firstSeenAtMs, 3_000_100, `M3 firstSeenAtMs = ${f.record(M3).firstSeenAtMs}`);
  const sample = f.rejections().find((r) => r.reason === "queue_full");
  assert.match(sample.message, /BEFORE dedupe/, `overflow sample = "${sample.message}"`);
  await f.stop();
  console.log(`         maxQueued 2: overflow ${f.stats().overflow}, ledger held ${heldAtOverflow} at the refusal; after draining one, M3 was taken at ${f.record(M3).firstSeenAtMs}`);
});

await ok("a notice still in flight when stop() lands is counted as after_stop, not emitted", async () => {
  let emit = null;
  const source = { id: "inflight", kind: "logs",
    start(ctx) { emit = ctx.emit; return { stop() {} }; } };
  const f = createSnipeFeed({ sources: [source], clock, schedule: fakeTimers().schedule, cancel: () => {} });
  const got = [];
  const drain = (async () => { for await (const r of f.notices()) got.push(r); })();
  NOW = 3_500_000;
  await f.start();
  emit({ mint: M1, slot: 600_000 });
  await flush();
  assert.equal(got.length, 1, `before stop the feed emitted ${got.length}`);
  await f.stop();
  const verdict = emit({ mint: M2, slot: 600_001 });        // the socket had one more in flight
  await drain;
  assert.equal(verdict.accepted, false, "a notice arriving after stop() was accepted");
  assert.equal(verdict.reason, "after_stop", `reason = ${verdict.reason}`);
  assert.equal(got.length, 1, `a post-stop notice reached the stream (${got.length} records)`);
  assert.equal(f.record(M2), null, "a post-stop notice entered the ledger");
  assert.equal(f.stats().afterStop, 1, `stats.afterStop = ${f.stats().afterStop}`);
  console.log(`         pre-stop 1 emitted · post-stop verdict "${verdict.reason}", stream still ${got.length}, afterStop counter ${f.stats().afterStop}`);
});

/* ── §9 a dead source is reported, and the survivors keep running ──────────────────── */

console.log("\n9. DEAD SOURCES");

await ok("a source that cannot connect is DEAD AND NAMED, and the other source still feeds", async () => {
  const t = fakeTransport();
  t.refuse = "websocket refused: ECONNREFUSED 127.0.0.1:8900";
  const clocks = fakeTimers();
  let rows = [];
  const f = createSnipeFeed({
    sources: [
      logsSubscribeSource({ id: "logs", programId: PUMPFUN_PROGRAM, transport: t, extractMint: (n) => (n?.create ? { mint: n.create } : null) }),
      pollSource({ id: "poll", fetchRows: async () => rows, intervalMs: 1_000 }),
    ],
    clock, schedule: clocks.schedule, cancel: clocks.cancel,
  });
  const got = [];
  const drain = (async () => { for await (const r of f.notices()) got.push(r); })();

  NOW = 4_000_000;
  const summary = await f.start();
  assert.equal(summary.failed.length, 1, `failed sources = ${summary.failed.length}`);
  assert.equal(summary.failed[0].id, "logs", `failed = ${summary.failed[0].id}`);
  assert.match(summary.failed[0].error, /ECONNREFUSED/, `the reason was lost: "${summary.failed[0].error}"`);
  assert.deepEqual([...summary.started], ["poll"], `started = ${JSON.stringify(summary.started)}`);

  const health = f.health(4_000_000);
  assert.equal(health.ok, true, "one live source is still a feed");
  assert.deepEqual([...health.dead], ["logs"], `dead = ${JSON.stringify(health.dead)}`);
  assert.match(health.message, /DEAD: logs/, `message = "${health.message}"`);

  rows = [pumpRow(M1, 4_000)];
  await clocks.runAll();
  assert.equal(got.length, 1, `the surviving source delivered ${got.length} record(s)`);
  assert.equal(got[0].firstSource, "poll", `firstSource = ${got[0].firstSource}`);
  await f.stop();
  await drain;
  console.log(`         start(): failed [logs: ${summary.failed[0].error}] · health "${health.message}" · survivor delivered ${got.length} launch`);
});

await ok("a source that dies after start is dead, reported, and restartable by the lane", async () => {
  const t = fakeTransport();
  const clocks = fakeTimers();
  const health = [];
  const f = createSnipeFeed({
    sources: [logsSubscribeSource({ id: "logs", programId: PUMPFUN_PROGRAM, transport: t, extractMint: (n) => (n?.create ? { mint: n.create } : null) })],
    clock, schedule: clocks.schedule, cancel: clocks.cancel, onHealth: (h) => health.push(h),
  });
  NOW = 5_000_000;
  await f.start();
  assert.equal(f.health(5_000_000).sources[0].state, "live", `state after start = ${f.health(5_000_000).sources[0].state}`);

  /* One error is a wobble; the source says so and the feed does not overreact. */
  t.breakIt("1006 abnormal closure");
  assert.equal(f.health(5_000_000).sources[0].state, "degraded", `one error read as ${f.health(5_000_000).sources[0].state}`);
  for (let i = 0; i < 4; i++) t.breakIt("1006 abnormal closure");
  const dead = f.health(5_000_000).sources[0];
  assert.equal(dead.state, "dead", `5 errors read as ${dead.state}`);
  assert.equal(dead.consecutiveErrors, 5, `consecutiveErrors = ${dead.consecutiveErrors}`);
  assert.ok(health.length >= 5, `onHealth fired ${health.length} times — a dead source must be reported, not discovered later`);

  const restarted = await f.restartSource("logs");
  assert.equal(restarted.ok, true, `restart failed: ${restarted.error}`);
  assert.equal(t.subscribes, 2, `subscribes after restart = ${t.subscribes}`);
  assert.equal(f.health(5_000_000).sources[0].restarts, 1, `restarts = ${f.health(5_000_000).sources[0].restarts}`);
  assert.equal(f.health(5_000_000).sources[0].state, "live", `state after restart = ${f.health(5_000_000).sources[0].state}`);
  await f.stop();
  console.log(`         1 error -> degraded, 5 -> dead, ${health.length} health reports, restart -> subscribes ${t.subscribes}, state live`);
});

await ok("every source dead: ok=false, state dead, and both are named", async () => {
  const t = fakeTransport();
  t.refuse = "ECONNREFUSED";
  const clocks = fakeTimers();
  const f = createSnipeFeed({
    sources: [
      logsSubscribeSource({ id: "logs", programId: PUMPFUN_PROGRAM, transport: t, extractMint: () => null }),
      pollSource({ id: "poll", fetchRows: async () => { throw new Error("HTTP 530"); }, intervalMs: 1_000 }),
    ],
    clock, schedule: clocks.schedule, cancel: clocks.cancel, cfg: { maxConsecutiveErrors: 1 },
  });
  NOW = 6_000_000;
  const summary = await f.start();
  await clocks.runAll();                              // the poll's first read fails
  const health = f.health(6_000_000);
  assert.equal(summary.failed.length, 1, `start() failures = ${summary.failed.length}`);
  assert.equal(health.ok, false, "a blind feed reported ok");
  assert.equal(health.state, "dead", `state = ${health.state}`);
  assert.deepEqual([...health.dead].sort(), ["logs", "poll"], `dead = ${JSON.stringify(health.dead)}`);
  assert.match(health.message, /DEAD: /, `message = "${health.message}"`);
  const pollState = health.sources.find((s) => s.id === "poll");
  assert.match(pollState.lastError, /HTTP 530/, `the poll's error was lost: "${pollState.lastError}"`);
  await f.stop();
  console.log(`         ok=${health.ok} state=${health.state} "${health.message}" · poll lastError "${pollState.lastError}"`);
});

/* ── §10 the venue-watch source, and what it refuses ───────────────────────────────── */

console.log("\n10. A VENUE ADAPTER AS A SOURCE");

const watchQueue = [];
const admissibleAdapter = (over = {}) => ({
  id: "pumpfun", programId: PUMPFUN_PROGRAM, supportsExactOut: true,
  quote: { mint: "So11111111111111111111111111111111111111112", decimals: 9, symbol: "SOL", oracle: "pyth-sol-usd" },
  ...Object.fromEntries(REQUIRED_VENUE_METHODS.map((m) => [m, () => null])),
  async *watch() { for (const n of watchQueue) yield n; },
  ...over,
});

await ok("an adapter that fails even the OBSERVE contract may not feed this lane", () => {
  assert.throws(() => sourceFromVenueWatch({ id: "junk" }), FeedConfigError);
  assert.throws(() => sourceFromVenueWatch(admissibleAdapter({ programId: "not-a-program" })), /program_id_invalid|admissible/);
  const good = sourceFromVenueWatch(admissibleAdapter());
  assert.equal(good.kind, "watch", `kind = ${good.kind}`);
  assert.equal(good.venueId, "pumpfun", `venueId = ${good.venueId}`);
  console.log(`         a malformed adapter is refused at construction; a contract-clean one yields a "${good.kind}" source`);
});

await ok("watch() notices carry the adapter's noticeAt as an ORIGIN claim, never as our stamp", async () => {
  watchQueue.length = 0;
  watchQueue.push({ venue: "pumpfun", mint: M1, creator: CREATOR, slot: 700_001, noticeAt: 6_999_000, source: "adapter", raw: { x: 1 } });
  const f = createSnipeFeed({ sources: [sourceFromVenueWatch(admissibleAdapter())], clock,
    schedule: fakeTimers().schedule, cancel: () => {} });
  const got = [];
  const drain = (async () => { for await (const r of f.notices()) got.push(r); })();
  NOW = 7_000_000;
  await f.start();
  await flush(); await flush();
  assert.equal(got.length, 1, `records = ${got.length}`);
  assert.equal(got[0].firstSeenAtMs, 7_000_000, `arrival stamp = ${got[0].firstSeenAtMs} (ours)`);
  assert.equal(got[0].sources[0].originAtMs, 6_999_000, `origin claim = ${got[0].sources[0].originAtMs} (theirs)`);
  assert.equal(got[0].sources[0].crossClock, true, "the adapter's clock was not labelled");
  assert.equal(got[0].firstSlot, 700_001, `slot = ${got[0].firstSlot}`);
  await f.stop();
  await drain;
  console.log(`         arrival ${got[0].firstSeenAtMs} (ours) vs noticeAt ${got[0].sources[0].originAtMs} (theirs), crossClock=${got[0].sources[0].crossClock}`);
});

await ok("a watch() that ENDS is dead immediately, not merely quiet", async () => {
  watchQueue.length = 0;
  const f = createSnipeFeed({ sources: [sourceFromVenueWatch(admissibleAdapter())], clock,
    schedule: fakeTimers().schedule, cancel: () => {} });
  NOW = 8_000_000;
  await f.start();
  await flush(); await flush();
  const state = f.health(8_000_000).sources[0];
  assert.equal(state.state, "dead", `an ended watch read as ${state.state} — silence thresholds would have hidden it for 5 minutes`);
  assert.match(state.reason, /ended/, `reason = "${state.reason}"`);
  await f.stop();
  console.log(`         watch() returned -> state ${state.state} at once, reason "${state.reason}"`);
});

/* ── §11 the pump.fun mapping and fetcher, offline ─────────────────────────────────── */

console.log("\n11. THE PUMP.FUN POLL, OFFLINE");

await ok("a listing row maps to a notice with no slot and a labelled origin time", () => {
  const notice = pumpfunRowToNotice(pumpRow(M1, 1_757_000_000));
  assert.equal(notice.mint, M1);
  assert.equal(notice.creator, CREATOR);
  assert.equal(notice.slot, null, `a listing row claimed slot ${notice.slot}`);
  assert.equal(notice.originAtMs, 1_757_000_000_000, `originAtMs = ${notice.originAtMs}`);
  assert.equal(pumpfunRowToNotice({}), null, "a row with no mint must map to nothing");
  assert.equal(pumpfunRowToNotice(null), null);
  console.log(`         mint ok, creator ok, slot ${notice.slot} (a poll has none), origin ${notice.originAtMs}`);
});

await ok("every page failing is an ERROR, not an empty market", async () => {
  const urls = [];
  const fetcher = pumpfunListingFetcher({ pages: 2, fetchJson: async (url) => { urls.push(url); throw new Error("HTTP 429"); } });
  await assert.rejects(fetcher(), /all 2 page request\(s\) failed/,
    "a totally failed poll returned [] — indistinguishable from a quiet minute");
  assert.equal(urls.length, 2, `requested ${urls.length} pages`);
  assert.match(urls[0], new RegExp(`limit=${PUMPFUN_PAGE_ROWS}`), `url = ${urls[0]}`);
  assert.match(urls[1], new RegExp(`offset=${PUMPFUN_PAGE_ROWS}`), `url = ${urls[1]}`);

  const partial = pumpfunListingFetcher({ pages: 2, fetchJson: async (url) => (url.includes("offset=0") ? [pumpRow(M1, 1)] : (() => { throw new Error("HTTP 429"); })()) });
  const rows = await partial();
  assert.equal(rows.length, 1, `a partially failed poll returned ${rows.length} row(s)`);
  console.log(`         2/2 pages failed -> throws · 1/2 failed -> ${rows.length} row kept (paging is independent, ${PUMPFUN_PAGE_ROWS} rows/page)`);
});

await ok("web3LogsTransport refuses a Connection without a PublicKey constructor", () => {
  assert.throws(() => web3LogsTransport({ onLogs: () => 1 }), /toPublicKey/);
  assert.throws(() => web3LogsTransport({}, { toPublicKey: (k) => k }), /onLogs/);
  let filter = null, subscribed = 0, removed = 0;
  const t = web3LogsTransport({
    onLogs: (f) => { filter = f; subscribed++; return 42; },
    removeOnLogsListener: (id) => { assert.equal(id, 42); removed++; },
  }, { toPublicKey: (key) => ({ key, isPublicKey: true }) });
  assert.equal(subscribed, 0, "web3LogsTransport() subscribed before subscribe() was called");
  const handle = t.subscribe({ programId: PUMPFUN_PROGRAM, commitment: "processed", onNotice: () => {}, onError: () => {} });
  assert.equal(subscribed, 1, `onLogs calls = ${subscribed}`);
  assert.equal(filter.isPublicKey, true, "a base58 string reached onLogs — that subscribes to nothing, forever");
  handle.unsubscribe();
  assert.equal(removed, 1, `removeOnLogsListener calls = ${removed}`);
  console.log(`         refuses without toPublicKey; constructs a PublicKey filter on subscribe(); unsubscribe removes listener 42`);
});

/* ── §12 shape, purity, and what this file must never contain ──────────────────────── */

console.log("\n12. PURITY AND THE SOURCE-LEVEL FENCE");

const SRC = fs.readFileSync(new URL("./snipe-feed.mjs", import.meta.url), "utf8");
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

await ok("nothing signs, nothing sends, no keypair is loaded on any path in this file", () => {
  for (const forbidden of [/Keypair/, /sendTransaction/, /sendRawTransaction/, /signTransaction/,
    /burner/i, /SECRET/, /PRIVATE_KEY/, /node:fs/, /node:child_process/])
    assert.doesNotMatch(CODE, forbidden, `snipe-feed.mjs reaches ${forbidden}`);
  console.log(`         no Keypair, no send*, no sign*, no secret, no fs, no child_process`);
});

await ok("the module imports nothing from the desk's exit path", () => {
  for (const forbidden of ["trade-policy.mjs", "strategy.mjs", "desk-mirror.mjs", "poller.mjs"])
    assert.doesNotMatch(CODE, new RegExp(`from\\s+["']\\./${forbidden.replace(".", "\\.")}["']`),
      `snipe-feed.mjs imports ${forbidden}`);
  console.log(`         imports: bs58, ./snipe-venue.mjs — nothing else`);
});

await ok("there is exactly one clock read in the file, and it is the injectable default", () => {
  const clockReads = (CODE.match(/Date\.now\(\)/g) ?? []).length;
  assert.equal(clockReads, 1, `Date.now() appears ${clockReads} times; every decision function must take its instant as an argument`);
  assert.match(CODE, /clock = \(\) => Date\.now\(\)/, "the one clock read is not the injectable default parameter");
  assert.doesNotMatch(CODE, /setInterval\(/, "setInterval cannot be driven by an injected scheduler");
  assert.doesNotMatch(CODE, /Math\.random/, "randomness makes a replay non-deterministic");
  console.log(`         Date.now() x${clockReads} (the default clock param) · no setInterval · no Math.random`);
});

await ok("the pure decision functions are pure: frozen out, arguments untouched, no hidden clock", () => {
  const arrival = arrivalOf({});
  const frozenIn = Object.freeze({ ...arrival });
  const record = openNoticeRecord(frozenIn);
  assert.equal(Object.isFrozen(record), true, "openNoticeRecord returned a mutable record");
  assert.deepEqual({ ...frozenIn }, { ...arrival }, "the arrival was mutated");
  const a = sourceLatency([record]), b = sourceLatency([record]);
  assert.deepEqual(a, b, "sourceLatency is not deterministic");
  assert.equal(Object.isFrozen(a), true, "sourceLatency returned a mutable table");
  const h1 = summarizeFeedHealth([sourceState({})], 1_000, FEED_DEFAULTS);
  const h2 = summarizeFeedHealth([sourceState({})], 1_000, FEED_DEFAULTS);
  assert.deepEqual(h1, h2, "summarizeFeedHealth is not deterministic at a fixed instant");
  console.log(`         openNoticeRecord / mergeArrival / sourceLatency / summarizeFeedHealth: frozen, deterministic, non-mutating`);
});

await ok("a feed with no sources is refused — it could not report that it is blind", () => {
  assert.throws(() => createSnipeFeed({ sources: [] }), /at least one source/);
  assert.throws(() => createSnipeFeed({ sources: [{ id: "a", kind: "logs" }] }), /start\(\)/);
  assert.throws(() => createSnipeFeed({ sources: [{ id: "a", kind: "socket", start() {} }] }), /kind/);
  const dup = { id: "same", kind: "logs", start() { return { stop() {} }; } };
  assert.throws(() => createSnipeFeed({ sources: [dup, { ...dup }] }), /share the id/);
  console.log(`         refused: no sources, no start(), an unknown kind, two sources sharing an id`);
});

console.log(`\n══ ${pass} passed, ${fail} failed ══\n`);
process.exit(fail ? 1 : 0);
