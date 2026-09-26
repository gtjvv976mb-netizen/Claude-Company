/**
 * THE PUBLIC AGENT PAGE, END TO END — the endpoint, the store, and the boundary.
 *
 * test-agent-desk.mjs pins the rules (the ladder, the rewards, the strategy validator) with no
 * database at all. This pins what happens when they meet real rows: that a reward cannot be paid
 * twice however often the page is loaded, that a strategy which would not run cannot be saved,
 * that the fee block the bot sends survives sanitising as its own figure, and that a leased
 * floor's page is not readable by a stranger.
 *
 * The one that matters most is the double-pay case. `creditRewards` runs on every page load, so
 * it is called far more often than anything else here — and a reward that can pay twice pays
 * forever.
 *
 *   CLAUDE_CO_DB=/tmp/x.db node test-agent-page.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* A throwaway database, set before anything imports the store. resolveDbFile() refuses to open
   the live journal without this, which is the guard that makes a test like this safe to run. */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-page-"));
process.env.CLAUDE_CO_DB = path.join(tmp, "test.db");

const { sanitizeExecutorFees } = await import("./src/office.js");
const store = await import("./src/agent-store.js");
const { AGENT_LEVELS, agentView } = await import("./src/agent-desk.js");
const { mayReadEventStream } = await import("./src/event-stream-policy.js");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
};

console.log("\nrewards cannot pay twice, however many times the page is loaded");
{
  const FLOOR = 7;
  const record = { closedTrades: 40, realizedSol: 0.3, winRate: 0.4 };   // clears rungs 2 and 3
  const first = store.creditRewards({ floor: FLOOR, ...record });
  ok("reaching level 3 pays the level 2 and level 3 rewards once",
    first.map((r) => r.level).join(",") === "2,3", first.map((r) => `${r.level}:${r.sol}`).join(" "));

  /* THE CASE THIS FILE EXISTS FOR: the page load, repeated. */
  for (let i = 0; i < 20; i++) store.creditRewards({ floor: FLOOR, ...record });
  ok("twenty more page loads pay nothing further", store.rewardsFor(FLOOR).length === 2);
  const expected = AGENT_LEVELS.filter((r) => r.level <= 3).reduce((a, r) => a + r.rewardSol, 0);
  ok("the total paid is exactly the ladder's own figure",
    Math.abs(store.rewardSolFor(FLOOR) - expected) < 1e-9, `${store.rewardSolFor(FLOOR)} vs ${expected}`);

  /* A DESK THAT LOSES MONEY IS PAID NOTHING, however much it has traded — the whole reason this
     ladder differs from theirs, checked against real rows rather than in the pure module. */
  store.creditRewards({ floor: 8, closedTrades: 1_000, realizedSol: -0.361, winRate: 0.08 });
  ok("a thousand losing trades earns no reward at all",
    store.rewardsFor(8).length === 0 && store.rewardSolFor(8) === 0);
  /* And an UNMEASURED record earns nothing either: `Number(null)` is 0, and a rung asking for
     "at least 0 SOL" must not be cleared by a missing measurement. */
  store.creditRewards({ floor: 9, closedTrades: 500, realizedSol: null, winRate: null });
  ok("an unmeasured record earns no reward", store.rewardsFor(9).length === 0);

  ok("a floor outside 1-50 is refused rather than stored",
    store.creditRewards({ floor: 0, ...record }).length === 0 && store.rewardsFor(99).length === 0);
}

console.log("\na strategy that would not run cannot be saved");
{
  const good = store.saveStrategy({ floor: 3, wallet: "Wa11et", strategy: { maxSolPerTrade: 0.05, minAgeHours: 2 } });
  ok("a valid strategy saves and reads back", good.ok === true
    && store.strategyFor(3).strategy.maxSolPerTrade === 0.05);
  ok("it records who saved it and when",
    store.strategyFor(3).wallet === "Wa11et" && store.strategyFor(3).updatedAtMs > 0);

  const bad = store.saveStrategy({ floor: 3, strategy: { moonMode: true } });
  ok("a dial the bot does not read is refused", bad.ok === false);
  ok("...and NOTHING was written, so the previous strategy stands",
    store.strategyFor(3).strategy.maxSolPerTrade === 0.05);
  ok("an out-of-bounds value is refused with its bounds",
    /must be between/.test(store.saveStrategy({ floor: 3, strategy: { maxSolPerTrade: 99 } }).errors[0]));
  ok("saving again replaces rather than duplicating",
    store.saveStrategy({ floor: 3, strategy: { maxSolPerTrade: 0.01 } }).ok === true
    && store.strategyFor(3).strategy.maxSolPerTrade === 0.01);
  ok("a floor with nothing saved reads as null, not as an empty strategy", store.strategyFor(44) === null);
  ok("a bad floor is refused", store.saveStrategy({ floor: 51, strategy: {} }).ok === false);

  /* RE-VALIDATED ON THE WAY OUT. A dial can be removed from the lane in a release, and a stored
     strategy naming it must not keep being shown as if the bot still read it. */
  const dbmod = await import("./src/lib/store.js");
  dbmod.default.prepare("UPDATE agent_strategies SET json = ? WHERE floor = ?")
    .run(JSON.stringify({ retiredDial: 5 }), 3);
  const stale = store.strategyFor(3);
  ok("a stored strategy naming a dial the lane no longer reads is reported STALE, not served",
    stale.stale === true && stale.strategy === null);
  ok("...and says which dial", /retiredDial/.test(stale.staleErrors.join(" ")));
  dbmod.default.prepare("UPDATE agent_strategies SET json = ? WHERE floor = ?").run("{not json", 3);
  ok("a corrupt row does not break the page", store.strategyFor(3).stale === true);
}

console.log("\nthe fee block arrives as its own figure and stays one");
{
  const sent = { mode: "dry", running: true, stats: { live: false, passes: 6, claimed: 0, failed: 0,
    skipped: 6, solClaimed: 0, bookErrors: 0, skippedBy: { not_live: 6 } } };
  const clean = sanitizeExecutorFees(sent);
  ok("a dry lane's block survives sanitising", clean.mode === "dry" && clean.running === true && clean.stats.passes === 6);
  /* `configured` and `running` are separate, because a lane that was asked for and never started
     is the most useful thing this block can say and would otherwise look like empty vaults. */
  ok("a lane that never started is distinguishable from one that found nothing",
    sanitizeExecutorFees({ mode: "dry", error: "rpc down" }).running === false);
  ok("an off lane says off", sanitizeExecutorFees({ mode: "off" }).mode === "off");
  ok("junk is dropped rather than rendered",
    sanitizeExecutorFees(null) === null && sanitizeExecutorFees({ mode: "wat" }).mode === "off");
  /* A CLAIM MOVES MONEY IN, so a negative claimed figure is a sign error rather than a loss —
     the opposite of the sniper's realised figure beside it, which is signed on purpose. */
  ok("a negative claimed amount is clamped, unlike a realised trading figure",
    sanitizeExecutorFees({ mode: "live", stats: { solClaimed: -5 } }).stats.solClaimed === 0);
  ok("an unknown skip clause is dropped rather than displayed",
    !("wat" in sanitizeExecutorFees({ mode: "dry", stats: { skippedBy: { wat: 3 } } }).stats.skippedBy));

  /* AND THE VIEW KEEPS THEM APART. This is the assertion that carries through from the bot's own
     book on a laptop to a public page. */
  const view = agentView({ floor: 50, closedTrades: 64, counted: 41, wins: 5, realizedSol: -0.361,
    feeSol: clean.stats.solClaimed, feeClaims: clean.stats.claimed, rewardSol: 0.03 });
  ok("trading, fees and rewards are three fields on the payload",
    view.tradingSol === -0.361 && view.feeSol === 0 && view.rewardSol === 0.03);
  for (const forbidden of ["total", "pnl", "pnlSol", "net", "balance"])
    ok(`the payload has no \`${forbidden}\``, !(forbidden in view));
  /* The win rate uses the READABLE closures as its denominator. Dividing by all 64 would count
     every unreadable closure as a loss and understate the record. */
  ok("the win rate is over the trades with a readable result, not over all of them",
    Math.abs(view.winRate - 5 / 41) < 1e-12 && view.unmeasuredTrades === 23);
}

console.log("\nthe boundary the page inherits");
{
  /* The endpoint reuses floorPrivate(), so HQ is public and a leased floor is not. Asserted here
     against the policy module the stream uses, because a second boundary written beside the
     first is a second boundary that can drift from it. */
  ok("HQ is readable by anyone, signed in or not",
    mayReadEventStream({ floor: 50, wallet: null, leaseWallet: null }) === true);
  ok("a leased floor is not readable by a stranger",
    mayReadEventStream({ floor: 7, wallet: "Somebody", leaseWallet: "Tenant" }) === false);
  ok("its tenant can read it", mayReadEventStream({ floor: 7, wallet: "Tenant", leaseWallet: "Tenant" }) === true);
  ok("a pass holder can read it",
    mayReadEventStream({ floor: 7, wallet: "Guest", leaseWallet: "Tenant", hasPass: true }) === true);

  const office = fs.readFileSync(new URL("./src/office.js", import.meta.url), "utf8");
  const route = office.slice(office.indexOf('if (url.pathname.startsWith("/api/agent/"))'),
    office.indexOf('if (url.pathname === "/api/record")'));
  ok("the agent route reuses floorPrivate rather than writing a second boundary",
    /floorPrivate\(floorNo\)/.test(route));
  ok("only the tenant may write a strategy", /holdsFloor\(floorNo\)/.test(route));
  ok("it reads the PUBLIC executor projection, which is already masked and already tested",
    /houseBotPublic\(floorNo\)/.test(route));
  ok("nothing in the payload is a secret, a session or an endpoint",
    !/executor_secret|executor_url|sid\b|heartbeat_log/.test(route));
  ok("an unknown sub-route is a 404 rather than falling through", /no such agent route/.test(route));

  /* THE SSE CHANGE IS ADDITIVE. Every existing client listens with onmessage, which fires only
     for events with NO name — so naming an event the floor already reads would make it vanish. */
  ok("the default event stays unnamed, and only new kinds carry a name",
    /const NAMED_EVENT_KINDS = new Set\(\["fees", "levelup", "reward"\]\)/.test(office)
    && /makes an event vanish from the floor/.test(office));
}

console.log("\nthe page itself");
{
  const html = fs.readFileSync(new URL("./viewer/agent.html", import.meta.url), "utf8");
  ok("it renders a dash for an unmeasured figure, never a zero",
    /A NULL IS A DASH, NEVER A ZERO/.test(html) && /text === null \? "—"/.test(html));
  ok("it prints the accounting sentence the payload carries rather than paraphrasing it",
    /a\.accounting/.test(html));
  ok("there are three money cards and no fourth",
    (html.match(/<div class="k">(Trading|Creator fees|House rewards)<\/div>/g) || []).length === 3
    && !/Total|Combined|PnL/.test(html));
  ok("it says an incomplete fee figure is a floor rather than a total",
    /a floor, not a total/.test(html));
  ok("it says plainly that a saved strategy has not reached the operator's laptop",
    /has not reached a laptop/.test(html));
  ok("it listens to the named kinds AND the unnamed default",
    /es\.onmessage/.test(html) && /for \(const kind of \["fees", "levelup", "reward"\]\)/.test(html));
  ok("a private floor is told so rather than shown an empty tape", /private to its tenant/.test(html));

  const build = fs.readFileSync(new URL("./scripts/build-viewer.mjs", import.meta.url), "utf8");
  ok("the page is published", /\{ src: "agent\.html",\s+out: "agent\.html" \}/.test(build));
}

console.log("\nthe named kinds are actually emitted, or they are dead names");
{
  const office = fs.readFileSync(new URL("./src/office.js", import.meta.url), "utf8");
  /* A NAME NOTHING EMITS IS WORSE THAN NO NAME: a page attaches a listener, nothing ever
     arrives, and the page looks broken rather than quiet. */
  for (const kind of ["fees", "levelup", "reward"])
    ok(`something emits ${kind}`, new RegExp(`emit\\("${kind}"`).test(office));
  ok("the SSE naming keys off the field the bus actually stamps (`type`, not `kind`)",
    /NAMED_EVENT_KINDS\.has\(ev\.type\)/.test(office));
  /* A LEVEL REACHED AND A REWARD PAID ARE TWO EVENTS: the first is the record improving, the
     second is money moving, and a page showing one would be showing half of what happened. */
  ok("a level reached and a reward paid are emitted separately",
    /emit\("levelup"/.test(office) && /emit\("reward"/.test(office));
  /* THE HEARTBEAT IS A SNAPSHOT REPEATED EVERY MINUTE, so "claimed: 3" arrives sixty times an
     hour and only the first is news. Detected by comparing against what was stored. */
  ok("a fee claim is announced once, by comparison, not once per pulse",
    /now2\.claimed > before\.claimed/.test(office)
    && /only the first of them is\n *news/.test(office));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} test-agent-page  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
