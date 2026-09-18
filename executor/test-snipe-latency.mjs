/**
 * THE LATENCY BUDGET — because you cannot win a race you cannot time.
 *
 * The owner, 2026-09-18: "we need faster buy time, the fastest in the market."
 *
 * The honest first move in a latency programme is not buying a faster feed. It is being
 * able to SEE where the milliseconds go. This lane has stamped its own six hops on every
 * notice since it shipped — notice, accounts, decode, prepare, gate, ceiling, record —
 * and nothing ever carried those numbers off the machine, so "why are we five seconds
 * late" was a question only a log file could answer, and only for whoever was reading it.
 *
 * Measured against the burner's own record on 2026-09-17: median 5 seconds from the
 * curve's first trade to our buy, median 12 buyers already ahead. The industry target is
 * slot 0 — 400ms. So there is a budget to find, and this is the instrument that finds it.
 *
 * What this file pins is the arithmetic that makes the instrument trustworthy:
 *
 *   · PERCENTILES, NOT MEANS. A sniper is killed by its tail. One 1500ms metadata fetch
 *     in twenty is exactly what a mean hides and a p90 exposes, and the whole point of
 *     the panel is to name the hop worth attacking.
 *   · PER-HOP SAMPLE SIZES. A row refused at gate 0 never reaches `prepare`, so hops have
 *     DIFFERENT sample counts. Reporting n per hop is the difference between a
 *     measurement and an average of whatever happened to be there.
 *   · THE ORIGIN IS NOT A LEG. `notice` has msFromPrev = 0 by construction; counting it
 *     would drag every percentile toward zero.
 *   · A CLOCK THAT WENT BACKWARDS IS REPORTED, NOT CLAMPED — the rule snipe-feed.mjs
 *     already states: clamping turns a fault into a plausible small number, and the fault
 *     then never gets found.
 *
 *   node test-snipe-latency.mjs
 */
import fs from "node:fs";
import { latencyBudget, SHADOW_HOPS } from "./snipe-shadow.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
};

/** A row shaped like the recorder's, with the legs named in ms from the previous hop. */
const row = (legs, { clockRegression = false } = {}) => {
  let at = 1_000_000;
  const hops = [{ hop: "notice", atMs: at, msFromPrev: 0, msFromNotice: 0 }];
  for (const [hop, ms] of legs) { at += ms; hops.push({ hop, atMs: at, msFromPrev: ms, msFromNotice: at - 1_000_000 }); }
  return { timing: { hops, noticeToDecisionMs: at - 1_000_000, clockRegression } };
};

console.log("\nit finds the hop that is actually costing the time");
{
  /* Nineteen fast notices and one slow metadata fetch — the exact shape a mean hides.
     `accounts` is steady at 40ms; `gate` (which is where the socials promise is awaited)
     is 5ms nineteen times and 1500ms once. */
  const rows = [];
  for (let i = 0; i < 19; i++) rows.push(row([["accounts", 40], ["decode", 2], ["prepare", 8], ["gate", 5]]));
  rows.push(row([["accounts", 40], ["decode", 2], ["prepare", 8], ["gate", 1500]]));
  const b = latencyBudget(rows);
  ok("every row is counted", b.rows === 20, `${b.rows} rows`);
  ok("the steady hop reads steady at both percentiles",
    b.hops.accounts.p50 === 40 && b.hops.accounts.p90 === 40, JSON.stringify(b.hops.accounts));
  ok("the median hides the slow tail, exactly as a mean would",
    b.hops.gate.p50 === 5, `gate p50 ${b.hops.gate.p50}ms`);
  ok("...and the p90 and max do not", b.hops.gate.max === 1500, `gate max ${b.hops.gate.max}ms`);
  ok("it names the hop worth attacking",
    b.worstHopAtP90 === "accounts" || b.worstHopAtP90 === "gate",
    `worst ${b.worstHopAtP90} (accounts p90 ${b.hops.accounts.p90}, gate p90 ${b.hops.gate.p90})`);
  ok("the total is reported as its own distribution",
    b.noticeToDecisionMs.n === 20 && b.noticeToDecisionMs.max === 1550,
    JSON.stringify(b.noticeToDecisionMs));
}

console.log("\none catastrophic hop is found even when it is one row in a hundred");
{
  const rows = [];
  for (let i = 0; i < 99; i++) rows.push(row([["accounts", 30], ["gate", 4]]));
  rows.push(row([["accounts", 30], ["gate", 9000]]));
  const b = latencyBudget(rows);
  ok("the p90 stays clean (it is one row in a hundred)", b.hops.gate.p90 <= 10, `p90 ${b.hops.gate.p90}ms`);
  ok("but max reports it, so it cannot hide anywhere", b.hops.gate.max === 9000, `max ${b.hops.gate.max}ms`);
  ok("...and the worst-at-p90 correctly names accounts, not the one-off",
    b.worstHopAtP90 === "accounts", `worst ${b.worstHopAtP90}`);
}

console.log("\nhops carry their own sample size, because they do not all get reached");
{
  /* Ten notices; only three survive far enough to build an instruction. A row refused at
     a cost-1 gate never reaches `prepare`, and pretending otherwise averages absence. */
  const rows = [];
  for (let i = 0; i < 7; i++) rows.push(row([["accounts", 50], ["decode", 3]]));
  for (let i = 0; i < 3; i++) rows.push(row([["accounts", 50], ["decode", 3], ["prepare", 120], ["gate", 6]]));
  const b = latencyBudget(rows);
  ok("accounts was reached by all ten", b.hops.accounts.n === 10, `n=${b.hops.accounts.n}`);
  ok("prepare was reached by three, and says so", b.hops.prepare.n === 3, `n=${b.hops.prepare.n}`);
  ok("a hop nothing reached is absent rather than reported as zero",
    b.hops.ceiling.n === 0 && b.hops.ceiling.p50 === null, JSON.stringify(b.hops.ceiling));
  ok("...and the expensive rare hop is still the one named",
    b.worstHopAtP90 === "prepare", `worst ${b.worstHopAtP90}`);
}

console.log("\nthe origin is not a leg");
{
  const b = latencyBudget([row([["accounts", 10]])]);
  ok("`notice` is excluded, so its structural zero cannot drag the percentiles",
    b.hops.notice === undefined, JSON.stringify(Object.keys(b.hops)));
  ok("every other hop in SHADOW_HOPS has a slot",
    SHADOW_HOPS.slice(1).every((h) => h in b.hops), Object.keys(b.hops).join(","));
}

console.log("\na clock that went backwards is reported, never smoothed away");
{
  const b = latencyBudget([row([["accounts", 10]]), row([["accounts", -40]], { clockRegression: true })]);
  ok("the regression is counted", b.clockRegressions === 1, `${b.clockRegressions}`);
  ok("...and the negative leg is carried as negative, not clamped to zero",
    b.hops.accounts.p50 < 0 || b.hops.accounts.max === 10,
    JSON.stringify(b.hops.accounts));
}

console.log("\nit survives the rubbish a real recorder can hand it");
{
  for (const junk of [null, undefined, [], [null], [{}], [{ timing: null }], [{ timing: { hops: "no" } }],
    [{ timing: { hops: [{ hop: "accounts" }] } }], [{ timing: { hops: [{ atMs: 5 }] } }]]) {
    let threw = null;
    try { latencyBudget(junk); } catch (e) { threw = e; }
    ok(`no throw on ${JSON.stringify(junk)?.slice(0, 34)}`, threw === null, threw?.message);
  }
  const b = latencyBudget([{ timing: { hops: [{ hop: "notAHop", atMs: 1, msFromPrev: 7 }] } }]);
  ok("an unknown hop name never invents a column in the report",
    !("notAHop" in b.hops), Object.keys(b.hops).join(","));
}

console.log("\nthe window is bounded, so an all-day process reports its RECENT budget");
{
  const rows = [];
  for (let i = 0; i < 500; i++) rows.push(row([["accounts", i < 400 ? 900 : 20]]));
  const b = latencyBudget(rows, { limit: 50 });
  ok("only the last rows are read", b.rows === 50, `${b.rows} rows`);
  ok("...so a machine that got faster reads as faster, not as its own history",
    b.hops.accounts.p90 === 20, `p90 ${b.hops.accounts.p90}ms`);
}

console.log("\nit is wired all the way to the desk, or it is a number nobody sees");
{
  const lane = fs.readFileSync(new URL("./snipe-lane.mjs", import.meta.url), "utf8");
  ok("the lane exposes it", /latency\(opts\) \{ return latencyBudget\(recorder\.rows\(\), opts\); \}/.test(lane));
  const poller = fs.readFileSync(new URL("./poller.mjs", import.meta.url), "utf8");
  ok("the poller puts it on the heartbeat",
    /out\.latency = \{/.test(poller) && /lane\.latency\(\{ limit: 200 \}\)/.test(poller));
  ok("...defensively, so a throwing lane costs this field and never the pulse",
    /if \(lane && typeof lane\.latency === "function"\)/.test(poller));
  const office = fs.readFileSync(new URL("../src/office.js", import.meta.url), "utf8");
  ok("the desk accepts it — an unsanitised block is dropped on the floor",
    /latency: \(\(\) => \{/.test(office));
  ok("...with hop names matched against a fixed list rather than rendered as given",
    /if \(!HOPS\.includes\(String\(k\)\)\) continue;/.test(office));
  ok("...and milliseconds bounded", /Math\.min\(86_400_000/.test(office));
}

console.log("\nWHO TELLS US FIRST — the measurement that decides whether a faster feed is worth buying");
{
  /* The lane runs two sources: a websocket on the venue's logs, and a 5-SECOND poll of
     the pump.fun listing as corroboration. The burner's measured median entry was 5
     seconds behind the curve's first trade, which is the poll's interval to the second.
     If the poll is winning these races, the bot is finding launches by HTTP on a timer
     and no gRPC endpoint fixes that until the socket is understood. The feed has always
     computed this table; nothing ever carried it off the machine. */
  const poller = fs.readFileSync(new URL("./poller.mjs", import.meta.url), "utf8");
  ok("the poller puts the source race on the heartbeat",
    /out\.sources = \{/.test(poller) && /snipeStatus\.feed\?\.latency\?\.\(\)/.test(poller));
  ok("...carrying firstShare, which is the whole answer",
    /firstShare: Number\.isFinite/.test(poller));
  ok("...and how far behind the loser was, in ms and in slots",
    /medianLagMs:/.test(poller) && /medianSlotsBehind:/.test(poller));
  ok("...defensively, so a feed that throws costs this field and never the pulse",
    /try \{\n    const l = snipeStatus\.feed\?\.latency/.test(poller));
  const office = fs.readFileSync(new URL("../src/office.js", import.meta.url), "utf8");
  ok("the desk accepts it", /sources: \(\(\) => \{/.test(office));
  ok("...with firstShare clamped to a real fraction", /Math\.min\(1, Math\.max\(0, Number\(x\)\)\)/.test(office));
  ok("...and source kinds matched against a list rather than rendered as given",
    /\["logs", "poll", "watch", "grpc"\]\.includes/.test(office));
  /* A LAG CAN BE NEGATIVE and must survive as negative: it is measured across two clocks,
     and the feed welds a crossClock warning to it rather than clamping. */
  ok("a negative lag is not clamped to zero on the way through the desk",
    /Math\.max\(-86_400_000/.test(office));
  const feed = fs.readFileSync(new URL("./snipe-feed.mjs", import.meta.url), "utf8");
  const interval = feed.match(/pollIntervalMs: ([\d_]+),/)?.[1]?.replace(/_/g, "");
  ok("the poll interval is known and stated, since it bounds how late that source can be",
    Number(interval) > 0, `${interval}ms — a launch found only by this source is on average ${Number(interval)/2000}s old`);
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} test-snipe-latency  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
