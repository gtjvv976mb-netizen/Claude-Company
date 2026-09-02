/**
 * COINS ARE STUDIED SEVERAL AT A TIME, AND THE BUDGET STILL HOLDS.
 *
 * The desk had never run two workups at once — every loop was `for … await` — and a
 * workup is eleven to thirteen model calls, so the ceiling was a scheduling one. Making
 * it concurrent moves real money, so the scheduler's exact contract is pinned here
 * against the same shape penthouse.js uses: a shared cursor, a shared spend
 * accumulator, and a reservation for the work already running.
 *
 * The first version of this failed its own check. Three workers against a $3 cap
 * overshot by $1.20 because a workup's cost lands only when it FINISHES, so every
 * worker saw a cap nothing in flight had charged yet and each started one more. The
 * reservation is what fixed it, and this is the test that caught it.
 */
let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

/** The scheduler from penthouse.js, with the workup replaced by a timer. */
async function schedule({ concurrency, budget, items, cost = 0.42, reserve = 0.42,
  reserving = true, growAt = null, failFreeAt = null } = {}) {
  const queue = Array.from({ length: items }, (_, i) => ({ mint: "M" + i }));
  let peak = 0, running = 0, studied = 0, spend = 0, inFlight = 0, cursor = 0;
  let stopped = null, grew = false, pickedGrown = false;
  const studyOne = async (c) => {
    running++; peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 15));
    running--;
    if (c.mint === failFreeAt) return "no_data";          // free failure: nothing charged
    spend += cost; studied++;
    if (c.mint === growAt && !grew) { grew = true; queue.push({ mint: "GROWN" }); }
    if (c.mint === "GROWN") pickedGrown = true;
    return "studied";
  };
  const worker = async () => {
    while (!stopped) {
      const used = spend;
      if (used + (reserving ? inFlight * reserve : 0) >= budget) { stopped = `budget $${used.toFixed(2)}`; return; }
      if (cursor >= queue.length) return;
      const coin = queue[cursor++];
      inFlight++;
      try { await studyOne(coin); } finally { inFlight--; }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { peak, studied, spend, stopped, pickedGrown, walked: cursor };
}

console.log("\nSEVERAL COINS AT ONCE");
{
  const r = await schedule({ concurrency: 3, budget: 999, items: 9 });
  ok("three workers actually run three at a time", r.peak === 3, `peak ${r.peak}`);
  ok("every coin is studied exactly once", r.studied === 9 && r.walked === 9, `${r.studied} studied`);
  const one = await schedule({ concurrency: 1, budget: 999, items: 5 });
  ok("concurrency 1 is the old strictly-serial loop", one.peak === 1 && one.studied === 5, `peak ${one.peak}`);
}

console.log("\nTHE CAP HOLDS, AND OVERSHOOTS BY AT MOST ONE WORKUP");
{
  const r = await schedule({ concurrency: 3, budget: 3, items: 20 });
  ok("the cycle stops on its budget", !!r.stopped, r.stopped);
  ok("the overshoot is at most one workup", r.spend <= 3 + 0.42 + 1e-9,
    `spent $${r.spend.toFixed(2)} against a $3 cap`);
  /* THE REGRESSION THIS FILE EXISTS FOR. Without the reservation the same run overshot
     by $1.20 — nearly three workups — because each worker saw an uncharged cap. */
  const naive = await schedule({ concurrency: 3, budget: 3, items: 20, reserving: false });
  ok("without the reservation it overshoots further", naive.spend > r.spend,
    `$${naive.spend.toFixed(2)} unreserved vs $${r.spend.toFixed(2)} reserved`);
  const serial = await schedule({ concurrency: 1, budget: 3, items: 20 });
  ok("and concurrency buys no worse a bound than serial did",
    r.spend <= serial.spend + 0.42 + 1e-9,
    `$${r.spend.toFixed(2)} concurrent vs $${serial.spend.toFixed(2)} serial`);
}

console.log("\nA QUEUE THAT GROWS MID-WALK IS STILL WALKED");
{
  // An unreadable coin costs nothing, so the cycle pushes a replacement from the bench
  // onto the queue while the workers are already walking it.
  const r = await schedule({ concurrency: 3, budget: 999, items: 6, growAt: "M1" });
  ok("a coin pushed on mid-walk is picked up", r.pickedGrown, `${r.walked} walked of 6+1`);
  const f = await schedule({ concurrency: 3, budget: 999, items: 6, failFreeAt: "M0" });
  ok("a free failure charges nothing", Math.abs(f.spend - 5 * 0.42) < 1e-9, `$${f.spend.toFixed(2)} for 5 paid`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
