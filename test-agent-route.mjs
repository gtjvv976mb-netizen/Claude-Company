/**
 * THE AGENT ROUTE AND THE FEE TAPE, AGAINST THE REAL SERVER ON A REAL SOCKET.
 *
 * The PR #45 review drove the desk with a throwaway database and found five things no unit
 * test of agentView could see, because each one lived in the route's wiring rather than in
 * the arithmetic:
 *
 *   · a guest pass-holder on a LEASED floor was handed the tenant's open positions, closed
 *     book and the bot's raw error text — the exact telemetry /feed and /executor/status
 *     withhold from that same guest;
 *   · a book whose every close was unreadable arrived with realizedSol 0, cleared rung 2's
 *     "at least 0 SOL" and booked a 0.01 SOL house reward on the first page load;
 *   · a pulse a week old still read "running";
 *   · every restart of a dry fee lane announced "claimed 0.000000 SOL in creator fees" on
 *     the public tape;
 *   · the dry lane's permanent zero of claims was shown as the floor's creator-fee revenue.
 *
 * Each is pinned here in the shape the reviewer reproduced it.
 *
 *   node test-agent-route.mjs
 */
if (!process.env.CLAUDE_CO_DB) throw new Error("test runner must provide CLAUDE_CO_DB");
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "agent-route-"));
process.env.CLAUDE_CO_DB = path.join(TMP, "office.db");
process.env.NODE_NO_WARNINGS = "1";
const HQ_OWNER = "3J57tqAJqRmSBn1ZYDu9JpMMyTfBHdcGGwECiPQeiji3";
process.env.HQ_OWNER_WALLET = HQ_OWNER;

const db = (await import("./src/lib/store.js")).default;
await import("./src/tower.js");
const { startOffice } = await import("./src/office.js");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
};

const PORT = 41000 + (process.pid % 9000);
const { server } = startOffice(PORT);
await new Promise((r) => setTimeout(r, 300));
const base = `http://127.0.0.1:${PORT}`;

const now = Date.now();
const TENANT = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const GUEST = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
for (const floor of [50, 7]) db.prepare("INSERT OR IGNORE INTO copy_settings (floor_no) VALUES (?)").run(floor);
db.prepare("UPDATE copy_settings SET executor_secret='secret-hq' WHERE floor_no=50").run();
db.prepare("UPDATE copy_settings SET executor_secret='secret-7' WHERE floor_no=7").run();
db.prepare("INSERT INTO leases (floor_no, wallet, base_units, name, created_at) VALUES (?,?,?,?,?)").run(7, TENANT, "0", "Seven", now);
for (const [token, wallet] of [["tok-tenant", TENANT], ["tok-guest", GUEST]])
  db.prepare("INSERT INTO sessions (token, wallet, created_at, expires_at) VALUES (?,?,?,?)").run(token, wallet, now, now + 1e9);
db.prepare(`INSERT INTO floor_passes (floor_no, viewer, owner, signature, base_units, granted_at, expires_at)
  VALUES (?,?,?,?,?,?,?)`).run(7, GUEST, TENANT, "sig".padEnd(88, "x"), "0", now, now + 1e9);

const events = [];
const sse = http.get(`${base}/events?floor=50`, (res) => { res.setEncoding("utf8"); res.on("data", (c) => events.push(c)); });
const req = async (method, p, { token, body } = {}) => {
  const r = await fetch(base + p, { method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};
const named = () => events.join("").split("\n\n").filter((x) => /^event: (fees|levelup|reward)/m.test(x));

const MINT = "So11111111111111111111111111111111111111112";
const snipe = (book) => ({ mode: "observe", state: "up",
  open: [{ mint: MINT, sizeSol: 0.05, entry: 1e-7, openedAt: now, high: 2e-7 }],
  lastError: "rpc 429 from a private endpoint",
  book });
const dryStats = (over = {}) => ({ live: false, passes: 1, claimed: 0, failed: 0, skipped: 1, solClaimed: 0,
  bookErrors: 0, skippedBy: { not_live: 1 }, claimableSol: 0.00707, claimableAt: now, ...over });

console.log("\na restart of a dry fee lane announces nothing");
{
  /* The poller's first pulse after boot goes out before the fee lane exists (stats null); the
     next one is the first with stats. That pair announced a claim on every reboot. */
  const blindBook = { closed: [], trades: 12, counted: 12, wins: 0, losses: 0, unknown: 12, readable: 0, realizedSol: null };
  await req("POST", "/api/floor/50/executor/heartbeat", { token: "secret-hq",
    body: { mode: "live", ts: now, snipe: snipe(blindBook), fees: { mode: "dry", configured: true, running: false, stats: null } } });
  await req("POST", "/api/floor/50/executor/heartbeat", { token: "secret-hq",
    body: { mode: "live", ts: now, snipe: snipe(blindBook), fees: { mode: "dry", configured: true, running: true, stats: dryStats() } } });
  /* And a restart proper: counters back to zero after a stored block. */
  await req("POST", "/api/floor/50/executor/heartbeat", { token: "secret-hq",
    body: { mode: "live", ts: now, snipe: snipe(blindBook), fees: { mode: "dry", configured: true, running: true, stats: dryStats({ passes: 1 }) } } });
  await new Promise((r) => setTimeout(r, 150));
  ok("no fees event for a lane that has claimed nothing", !named().some((e) => /event: fees/.test(e)),
    named().join(" | ").slice(0, 200));
}

console.log("\na record nobody could read earns nothing");
{
  const a = await req("GET", "/api/agent/50");
  ok("the route answers", a.status === 200, String(a.status));
  ok("the trading figure is unknown, not 0", a.body.tradingSol === null, String(a.body.tradingSol));
  ok("the level stays 1", a.body.level === 1, `level ${a.body.level}`);
  ok("no reward was booked", (a.body.rewards ?? []).length === 0 && !(a.body.rewardSol > 0), JSON.stringify(a.body.rewards));
  ok("all twelve closes are reported unmeasured", a.body.unmeasuredTrades === 12);
  await new Promise((r) => setTimeout(r, 150));
  ok("no levelup or reward event went out", !named().some((e) => /event: (levelup|reward)/.test(e)));
}

console.log("\nfees: what landed, and what is merely waiting, are different fields");
{
  const a = await req("GET", "/api/agent/50");
  ok("a dry lane's claimed figure is not shown as revenue", a.body.feeSol === null && a.body.feeClaims === null,
    `feeSol ${a.body.feeSol}, claims ${a.body.feeClaims}`);
  ok("...and no false 'an amount was never reported' flag", a.body.feeSolComplete === null);
  ok("what the last read found waiting is its own field", a.body.feeClaimableSol === 0.00707, String(a.body.feeClaimableSol));
}

console.log("\n'running' needs a recent pulse");
{
  ok("a fresh pulse with the lane up reads running", (await req("GET", "/api/agent/50")).body.live === true);
  const stored = JSON.parse(db.prepare("SELECT executor_heartbeat FROM copy_settings WHERE floor_no=50").get().executor_heartbeat);
  stored.seenAt = now - 7 * 86_400_000;
  db.prepare("UPDATE copy_settings SET executor_heartbeat=? WHERE floor_no=50").run(JSON.stringify(stored));
  const stale = await req("GET", "/api/agent/50");
  ok("a week-old pulse that said 'up' does not read running", stale.body.live === false, String(stale.body.live));
  ok("...and the page is told how old the pulse is", stale.body.pulseAgeMs >= 7 * 86_400_000 - 5_000);
}

console.log("\na pass-holder sees the record, not the tenant's bot");
{
  const book = { closed: [{ mint: MINT, closedAt: now, reason: "stop", realizedSol: -0.01, sizeSol: 0.05 }],
    trades: 1, counted: 1, wins: 0, losses: 1, unknown: 0, readable: 1, realizedSol: -0.01 };
  await req("POST", "/api/floor/7/executor/heartbeat", { token: "secret-7",
    body: { mode: "live", ts: now, snipe: snipe(book), fees: { mode: "dry", configured: true, running: true, stats: dryStats() } } });
  const guest = await req("GET", "/api/agent/7", { token: "tok-guest" });
  ok("the guest can read the floor's agent page", guest.status === 200, String(guest.status));
  ok("...but not the tenant's open positions, closed book or bot errors", guest.body.snipe === null, JSON.stringify(guest.body.snipe)?.slice(0, 80));
  ok("...nor the fee lane's block", guest.body.feeLane === null);
  ok("...and still gets the aggregate record", guest.body.closedTrades === 1 && guest.body.tradingSol === -0.01);
  const tenant = await req("GET", "/api/agent/7", { token: "tok-tenant" });
  ok("the tenant sees their own bot's blocks", tenant.body.snipe?.open?.length === 1 && tenant.body.feeLane?.mode === "dry");
  ok("a stranger is still refused the floor", (await req("GET", "/api/agent/7")).status === 403);
  const hq = await req("GET", "/api/agent/50");
  ok("HQ's bot stays public, as it always was", hq.body.snipe !== null && hq.body.feeLane !== null);
}

console.log("\na real claim, after a restart, is still announced");
{
  const hb = (stats) => req("POST", "/api/floor/50/executor/heartbeat", { token: "secret-hq",
    body: { mode: "live", ts: Date.now(), fees: { mode: "live", configured: true, running: true, stats } } });
  await hb(dryStats({ live: true, claimed: 3, solClaimed: 0.3 }));
  await hb(dryStats({ live: true, claimed: 0, solClaimed: 0 }));             // restart: counters reset
  await hb(dryStats({ live: true, claimed: 1, solClaimed: 0.02 }));          // first claim after it
  await new Promise((r) => setTimeout(r, 150));
  const fees = named().filter((e) => /event: fees/.test(e));
  ok("the claim after the restart is announced, measured from zero",
    fees.some((e) => /claimed 0\.020000 SOL/.test(e)), fees.join(" | ").slice(0, 240));
  ok("the restart itself announced nothing", !fees.some((e) => /claimed 0\.000000/.test(e)));
}

sse.destroy();
server.close();
server.closeAllConnections?.();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} test-agent-route  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
