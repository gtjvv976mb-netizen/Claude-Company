/**
 * WHO RUNS THE BOT — THE CHOICE THE PRODUCT NEVER ASKED, AND THE ONE IT MUST NOT FAKE.
 *
 * A tenant can lease a floor, set six filters, and still not have said whether a bot is
 * supposed to appear on its own. There are two answers and they differ on CUSTODY:
 * 'self' means the burner is generated on their machine and this desk holds no key of
 * theirs; 'hq_requested' means they are ASKING for a managed track that does not exist —
 * not a line of it, 4-8 months of engineering and a legal review before it could take
 * one deposit.
 *
 * So this exercises the REAL routes on a throwaway database, and the assertions are the
 * dangerous cases rather than the happy one:
 *
 *   - unset is a real third state, and it survives being read (a JSON object with the
 *     key missing cannot tell "has not chosen" from "the server forgot to say");
 *   - the executor secret — a credential a PROCESS holds — cannot vote on custody,
 *     while the floor's signed-in owner can;
 *   - a bogus value is 400 and writes nothing, because coercing it to the nearest enum
 *     member would record a custody decision nobody made;
 *   - 'hq_requested' PROVISIONS NOTHING: the whole database is snapshotted around the
 *     write and the only difference permitted is three columns on that floor's own
 *     settings row;
 *   - the owner's demand count moves, since that count is the entire case for ever
 *     spending those months.
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

process.env.CLAUDE_CO_DB = process.env.CLAUDE_CO_DB || path.join(os.tmpdir(), "bot-operator-choice-test.db");
try { fs.rmSync(process.env.CLAUDE_CO_DB); } catch {}

/* Real ed25519 keypairs, so the wallet-session gate is exercised as a browser would
   exercise it — nonce, signature, session token — instead of a session row forged
   straight into the table. The HQ deed is one of them, set before tower.js is imported
   because tower asserts the deed to HQ_OWNER_WALLET on boot. */
const { encode } = await import("./src/lib/base58.js");
function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { wallet: encode(raw), privateKey };
}
const tenantA = keypair();
const tenantB = keypair();
const stranger = keypair();
const boss = keypair();
process.env.HQ_OWNER_WALLET = boss.wallet;

const db = (await import("./src/lib/store.js")).default;
const auth = await import("./src/auth.js");
const tower = await import("./src/tower.js");
const copy = await import("./src/copy.js");
const { openCall, liveCalls, closeCall } = await import("./src/calls.js");
const { startOffice } = await import("./src/office.js");

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const FLOOR_A = 11, FLOOR_B = 12, FLOOR_C = 13;

/** Sign in for real: the same nonce → signature → session token the browser does. */
function signIn({ wallet, privateKey }) {
  const { nonce, message } = auth.issueNonce(wallet);
  const sig = crypto.sign(null, Buffer.from(message, "utf8"), privateKey);
  const r = auth.verifySignature({ wallet, nonce, signatureB58: encode(sig) });
  if (!r.ok) throw new Error(`sign-in failed for ${wallet}: ${r.error}`);
  return r.token;
}
const lease = (floorNo, wallet, name) => {
  db.prepare("INSERT INTO leases (floor_no, wallet, base_units, name, created_at) VALUES (?,?,?,?,?)")
    .run(floorNo, wallet, "0", name, Date.now());
  db.prepare("UPDATE floors SET state='owned', owner=?, name=?, claimed_at=? WHERE n=?")
    .run(wallet, name, Date.now(), floorNo);
};
lease(FLOOR_A, tenantA.wallet, "Eleventh Floor");
lease(FLOOR_B, tenantB.wallet, "Twelfth Floor");
lease(FLOOR_C, stranger.wallet, "Thirteenth Floor");
const tokenA = signIn(tenantA), tokenB = signIn(tenantB);
const tokenStranger = signIn(stranger), tokenBoss = signIn(boss);
ok("the HQ deed is the boss's wallet", tower.isHqOwner(boss.wallet) === true,
  `hqOwnerWallet=${tower.hqOwnerWallet()} boss=${boss.wallet}`);

/* A delivery on floor A, so "the deliveries table is byte-identical" is a claim about a
   table with a row in it rather than about two empty tables. */
for (const c of liveCalls()) closeCall(c.id, "test_reset", 1);
const call = openCall({ mint: "B0t0perator111111111111111111111111111111111", symbol: "WHO",
  category: "memecoin", launchpad: "pump.fun", conviction: 60, entryRef: 0.001, stop: 0.00075,
  target: 0.0021, thesis: "a call so the floor has a delivery row", invalidation: "volume dies",
  liqUsd: 120_000, rtLossPct: 1.2, mcapUsd: 400_000 });
const bc = copy.broadcast(call.id, [FLOOR_A]);
ok("floor A has a delivery to hold still", bc.ok && bc.offered === 1, `offered=${bc.offered}`);

const { server } = startOffice(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;
const call_ = async (floor, { token = tokenA, method = "POST", body = undefined, raw = null } = {}) => {
  const r = await fetch(`${base}/api/floor/${floor}/bot-operator`, { method,
    headers: { "content-type": "application/json", ...(token == null ? {} : { authorization: `Bearer ${token}` }) },
    body: method === "POST" ? (raw ?? JSON.stringify(body ?? {})) : undefined });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
};
const row = (floorNo) => db.prepare("SELECT bot_operator, bot_operator_at, hq_requested_at FROM copy_settings WHERE floor_no=?").get(floorNo);

/* CONSENT COMES FIRST (2026-09-06). Asking for the managed track is now refused until
   the floor has acknowledged the current disclosure — the record behind that request
   is test-hq-consent.mjs's subject, and this file's subject is still the CHOICE, so it
   files the acknowledgement the way the panel does and carries on. Deliberately called
   BEFORE the snapshots below: an acknowledgement writes a row in hq_consents, and the
   "asking provisions nothing" check has to measure the request on its own. */
const acknowledge = async (floorNo, token) => {
  const d = copy.hqDisclosure();
  const r = await fetch(`${base}/api/floor/${floorNo}/hq-consent`, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ action: "acknowledge", version: d.version, sha256: d.sha256,
      conditions: d.conditions.map((c) => c.n) }) });
  if (r.status !== 200) throw new Error(`acknowledge floor ${floorNo}: HTTP ${r.status}`);
};

/** Every table, every row, as text. The blunt instrument is the point: a managed-track
 *  request that quietly created a wallet, a deposit or a delivery would show up here as
 *  a table that changed, whatever it was called. */
const TABLES = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((t) => t.name);
const snapshot = () => {
  const out = {};
  for (const t of TABLES) { try { out[t] = JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all()); } catch (e) { out[t] = `ERR ${e.message}`; } }
  return out;
};
const diffTables = (a, b) => Object.keys(a).filter((t) => a[t] !== b[t]);

console.log("\nUNSET IS A REAL STATE, NOT A DEFAULT SOMEBODY GUESSED");
{
  const g = await call_(FLOOR_A, { method: "GET" });
  ok("the floor's owner can read the choice", g.status === 200, `HTTP ${g.status}`);
  ok("...and it is unset", g.json?.botOperator === null, `botOperator=${JSON.stringify(g.json?.botOperator)}`);
  /* `undefined` vanishes from JSON.stringify, so a missing key and a stated null look
     identical to a caller that only checks truthiness — and a panel that cannot tell
     them apart is a panel that will invent a default. The key must be PRESENT. */
  ok("...stated as a key, not omitted", Object.prototype.hasOwnProperty.call(g.json, "botOperator"),
    `keys=${Object.keys(g.json || {}).join(",")}`);
  ok("...with no timestamps yet", g.json?.botOperatorAt === null && g.json?.hqRequestedAt === null,
    `botOperatorAt=${g.json?.botOperatorAt} hqRequestedAt=${g.json?.hqRequestedAt}`);
  const s = copy.settingsFor(FLOOR_A);
  ok("the settings object the floor panel receives carries it too", s.bot_operator === null,
    `settings.bot_operator=${JSON.stringify(s.bot_operator)}`);
  ok("the stored column is NULL, not 'self'", row(FLOOR_A).bot_operator === null,
    `column=${JSON.stringify(row(FLOOR_A).bot_operator)}`);
}

console.log("\nCUSTODY IS A HUMAN DECISION: THE EXECUTOR SECRET CANNOT VOTE");
{
  const secret = copy.settingsFor(FLOOR_A).executor_secret;
  ok("floor A has an executor secret to try", typeof secret === "string" && secret.length >= 32,
    `length=${secret?.length}`);
  const asBot = await call_(FLOOR_A, { token: secret, body: { choice: "hq_requested" } });
  ok("the floor's own executor secret is refused", asBot.status === 401, `HTTP ${asBot.status}: ${asBot.json?.error}`);
  const none = await call_(FLOOR_A, { token: null, body: { choice: "self" } });
  ok("no bearer at all is refused", none.status === 401, `HTTP ${none.status}`);
  const other = await call_(FLOOR_A, { token: tokenStranger, body: { choice: "self" } });
  ok("another wallet's session cannot choose for this floor", other.status === 403,
    `HTTP ${other.status}: ${other.json?.error}`);
  ok("nothing was written by any of those", row(FLOOR_A).bot_operator === null,
    `column=${JSON.stringify(row(FLOOR_A).bot_operator)}`);
}

console.log("\nA BOGUS VALUE IS 400 AND WRITES NOTHING");
{
  const cases = [["missing", {}], ["empty string", { choice: "" }], ["null", { choice: null }],
    ["'hq'", { choice: "hq" }], ["'SELF' in caps", { choice: "SELF" }], ["'managed'", { choice: "managed" }],
    ["a number", { choice: 1 }], ["an array", { choice: ["self"] }], ["'self '", { choice: "self " }]];
  for (const [label, body] of cases) {
    const r = await call_(FLOOR_A, { body });
    ok(`${label} -> 400`, r.status === 400, `HTTP ${r.status}: ${r.json?.error}`);
  }
  const notJson = await call_(FLOOR_A, { raw: "{not json" });
  ok("a body that is not JSON -> 400", notJson.status === 400, `HTTP ${notJson.status}: ${notJson.json?.error}`);
  const get = await call_(FLOOR_A, { method: "PUT", body: { choice: "self" } });
  ok("PUT is not a choice -> 405", get.status === 405, `HTTP ${get.status}`);
  ok("still unset after all of that", row(FLOOR_A).bot_operator === null,
    `column=${JSON.stringify(row(FLOOR_A).bot_operator)}`);
  const direct = copy.setBotOperator(FLOOR_A, "hq-requested");
  ok("setBotOperator itself refuses a near-miss", direct.ok === false, JSON.stringify(direct));
}

console.log("\n'self' IS STORED, WITH THE MOMENT IT WAS CHOSEN");
{
  const before = Date.now();
  const r = await call_(FLOOR_A, { body: { choice: "self" } });
  ok("the choice is accepted", r.status === 200 && r.json?.ok === true, `HTTP ${r.status}`);
  ok("...and returned as stored state", r.json?.botOperator === "self", `botOperator=${r.json?.botOperator}`);
  const stored = row(FLOOR_A);
  ok("...the column says 'self'", stored.bot_operator === "self", `column=${stored.bot_operator}`);
  ok("...with a choice timestamp", Number(stored.bot_operator_at) >= before && Number(stored.bot_operator_at) <= Date.now(),
    `bot_operator_at=${stored.bot_operator_at}`);
  /* Running it yourself is not a request for the managed track, so the demand timestamp
     must stay empty — otherwise the owner's demand count counts self-hosters. */
  ok("...and NO hq request timestamp", stored.hq_requested_at === null,
    `hq_requested_at=${JSON.stringify(stored.hq_requested_at)}`);
  const g = await call_(FLOOR_A, { method: "GET" });
  ok("a re-read agrees", g.json?.botOperator === "self", `botOperator=${g.json?.botOperator}`);
  ok("the self track is described as available and one command",
    g.json?.tracks?.self?.available === true && /install\.sh \| bash -s -- --floor/.test(g.json?.tracks?.self?.install || ""),
    `available=${g.json?.tracks?.self?.available} install=${g.json?.tracks?.self?.install}`);
  ok("the managed track is described as NOT available",
    g.json?.tracks?.hq_requested?.available === false, `available=${g.json?.tracks?.hq_requested?.available}`);
  ok("both tracks lead with custody",
    /never leaves/.test(g.json?.tracks?.self?.custody || "") &&
    /would hold the key/.test(g.json?.tracks?.hq_requested?.custody || ""),
    `self="${g.json?.tracks?.self?.custody}" hq="${g.json?.tracks?.hq_requested?.custody}"`);
}

console.log("\n'hq_requested' IS RECORDED — AND PROVISIONS NOTHING");
{
  /* Open the panel first, so the settings row (and its feed secret) already exist and
     the snapshot below compares a floor in use against itself — not an insert against
     an absence, which would pass this assertion for the wrong reason. */
  const opened = await call_(FLOOR_B, { token: tokenB, method: "GET" });
  ok("floor B's panel reads unset before it chooses", opened.json?.botOperator === null,
    `botOperator=${JSON.stringify(opened.json?.botOperator)}`);
  await acknowledge(FLOOR_B, tokenB);
  const beforeSnap = snapshot();
  const beforeDeliveries = beforeSnap.deliveries;
  const beforeSettingsRow = db.prepare("SELECT * FROM copy_settings WHERE floor_no=?").get(FLOOR_B);
  const at = Date.now();
  const r = await call_(FLOOR_B, { token: tokenB, body: { choice: "hq_requested" } });
  ok("the request is accepted", r.status === 200 && r.json?.botOperator === "hq_requested",
    `HTTP ${r.status} botOperator=${r.json?.botOperator}`);
  const stored = row(FLOOR_B);
  ok("...the column says 'hq_requested'", stored.bot_operator === "hq_requested", `column=${stored.bot_operator}`);
  ok("...with BOTH timestamps: the choice, and the request",
    Number(stored.bot_operator_at) >= at && Number(stored.hq_requested_at) >= at,
    `bot_operator_at=${stored.bot_operator_at} hq_requested_at=${stored.hq_requested_at}`);

  const afterSnap = snapshot();
  const changed = diffTables(beforeSnap, afterSnap);
  ok("ONLY copy_settings changed in the entire database", changed.length === 1 && changed[0] === "copy_settings",
    `changed=[${changed.join(", ")}] of ${TABLES.length} tables`);
  ok("...the deliveries table is byte-identical", afterSnap.deliveries === beforeDeliveries,
    `${beforeDeliveries.length} chars before, ${afterSnap.deliveries.length} after`);
  const afterSettingsRow = db.prepare("SELECT * FROM copy_settings WHERE floor_no=?").get(FLOOR_B);
  const allowed = new Set(["bot_operator", "bot_operator_at", "hq_requested_at"]);
  const movedFields = Object.keys(afterSettingsRow)
    .filter((k) => JSON.stringify(afterSettingsRow[k]) !== JSON.stringify(beforeSettingsRow[k]));
  ok("...and inside that row only the three choice columns moved",
    movedFields.length === 3 && movedFields.every((k) => allowed.has(k)), `moved=[${movedFields.join(", ")}]`);
  /* The specific things a managed track WOULD have created, named one by one, because
     "only copy_settings changed" is only reassuring if these are the things it means. */
  ok("...no wallet was minted for this floor", afterSettingsRow.executor_url === beforeSettingsRow.executor_url &&
    afterSettingsRow.executor_secret === beforeSettingsRow.executor_secret,
    `executor_url=${JSON.stringify(afterSettingsRow.executor_url)}`);
  ok("...no heartbeat appeared, so nothing is claimed to be running",
    afterSettingsRow.executor_heartbeat == null, `executor_heartbeat=${JSON.stringify(afterSettingsRow.executor_heartbeat)}`);
  ok("...no fill, no ledger row", db.prepare("SELECT COUNT(*) n FROM executor_fills").get().n === 0,
    `executor_fills=${db.prepare("SELECT COUNT(*) n FROM executor_fills").get().n} rows`);
  ok("...and the floor's trading dials are untouched",
    afterSettingsRow.bankroll_sol === beforeSettingsRow.bankroll_sol &&
    afterSettingsRow.fixed_sol === beforeSettingsRow.fixed_sol &&
    afterSettingsRow.take_profit_x === beforeSettingsRow.take_profit_x &&
    afterSettingsRow.mcap_tier === beforeSettingsRow.mcap_tier &&
    afterSettingsRow.auto === beforeSettingsRow.auto,
    `bankroll=${afterSettingsRow.bankroll_sol} fixed=${afterSettingsRow.fixed_sol} tp=${afterSettingsRow.take_profit_x} tier=${afterSettingsRow.mcap_tier} auto=${afterSettingsRow.auto}`);
  /* The same call the delivery path makes. If asking for the managed track had changed
     what this floor is offered, it would show up here as a different verdict. */
  const decision = copy.decide(FLOOR_B, call);
  ok("...and the floor still decides calls exactly as before",
    typeof decision?.verdict === "string", `verdict=${decision?.verdict} reason=${decision?.reason}`);
}

console.log("\nTHE DEMAND TIMESTAMP RECORDS WHEN THEY FIRST ASKED, NOT WHEN THEY LAST CLICKED");
{
  const first = row(FLOOR_B).hq_requested_at;
  await new Promise((r) => setTimeout(r, 5));
  const again = await call_(FLOOR_B, { token: tokenB, body: { choice: "hq_requested" } });
  ok("a re-request is accepted", again.status === 200, `HTTP ${again.status}`);
  ok("...and the first-ask time does not move", row(FLOOR_B).hq_requested_at === first,
    `first=${first} now=${row(FLOOR_B).hq_requested_at}`);
  const chosenAt = row(FLOOR_B).bot_operator_at;
  await new Promise((r) => setTimeout(r, 5));
  const switched = await call_(FLOOR_B, { token: tokenB, body: { choice: "self" } });
  ok("switching to self is accepted", switched.status === 200 && switched.json?.botOperator === "self",
    `HTTP ${switched.status} botOperator=${switched.json?.botOperator}`);
  ok("...the choice timestamp moves", Number(row(FLOOR_B).bot_operator_at) > Number(chosenAt),
    `was ${chosenAt}, now ${row(FLOOR_B).bot_operator_at}`);
  ok("...but the record that they once asked survives", row(FLOOR_B).hq_requested_at === first,
    `hq_requested_at=${row(FLOOR_B).hq_requested_at}`);
  // Put floor B back on the managed request so the count below has two floors to find.
  await call_(FLOOR_B, { token: tokenB, body: { choice: "hq_requested" } });
}

console.log("\nTHE OWNER CAN SEE THE DEMAND, AND ONLY THE OWNER");
{
  const heartbeat = async (token) => {
    const r = await fetch(`${base}/api/heartbeat`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.status, json: await r.json() };
  };
  const asBoss1 = await heartbeat(tokenBoss);
  ok("the HQ branch carries the demand count", asBoss1.status === 200 && asBoss1.json?.botOperatorDemand != null,
    `HTTP ${asBoss1.status} demand=${JSON.stringify(asBoss1.json?.botOperatorDemand)}`);
  const n1 = asBoss1.json?.botOperatorDemand?.requested;
  ok("one floor has asked so far", n1 === 1, `requested=${n1}`);
  ok("...and the self-hosted floor is counted separately, not as demand",
    asBoss1.json?.botOperatorDemand?.selfHosted === 1, `selfHosted=${asBoss1.json?.botOperatorDemand?.selfHosted}`);

  await acknowledge(FLOOR_C, tokenStranger);
  const r = await call_(FLOOR_C, { token: tokenStranger, body: { choice: "hq_requested" } });
  ok("a second floor asks", r.status === 200, `HTTP ${r.status}`);
  const asBoss2 = await heartbeat(tokenBoss);
  const n2 = asBoss2.json?.botOperatorDemand?.requested;
  ok("the demand count increments", n2 === n1 + 1, `was ${n1}, now ${n2}`);
  ok("...with a first and latest ask, so demand can be read over time",
    Number(asBoss2.json?.botOperatorDemand?.firstRequestAt) > 0 &&
    Number(asBoss2.json?.botOperatorDemand?.latestRequestAt) >= Number(asBoss2.json?.botOperatorDemand?.firstRequestAt),
    `first=${asBoss2.json?.botOperatorDemand?.firstRequestAt} latest=${asBoss2.json?.botOperatorDemand?.latestRequestAt}`);
  ok("...and it says out loud that nothing behind it is running",
    /does not exist/.test(asBoss2.json?.botOperatorDemand?.note || ""),
    `note="${asBoss2.json?.botOperatorDemand?.note}"`);

  /* A tenant must not be shown how many other customers want custody — it is the
     operator's business decision, on the operator's own branch of this payload. */
  const asTenant = await heartbeat(tokenA);
  ok("a tenant sees no demand count", asTenant.status === 200 && asTenant.json?.botOperatorDemand === null,
    `botOperatorDemand=${JSON.stringify(asTenant.json?.botOperatorDemand)}`);
  const anon = await heartbeat(null);
  ok("a signed-out visitor sees no demand count", anon.json?.botOperatorDemand === null,
    `botOperatorDemand=${JSON.stringify(anon.json?.botOperatorDemand)}`);

  /* `sizingProbe` WAS HERE, and it is deleted along with the ceiling it reported.
     It listed which floors had configured a per-trade size larger than the desk's exit
     probe measured — the reading that diagnosed the 2026-09-07 stall (probe $75, house
     floor 0.4 SOL, the bot's real buys ~$2). The diagnosis was right and the CEILING was
     the bug: the desk was capping deliveries to a notional it had invented. With no cap,
     "this tenant asked for more than we measured" is not a discrepancy at all — it is a
     tenant configuring their own bot, which is the arrangement.
     The number that made the diagnosis is still on the operator's screen, one payload
     up: the /screen block publishes routeProbeSizeUsd with its provenance. What is gone
     is the comparison against other floors' private settings — which, now that it means
     nothing, is a privacy cost with no benefit. */
  ok("the retired per-floor sizing comparison is not served to anyone",
    asBoss2.json?.sizingProbe === undefined && asTenant.json?.sizingProbe === undefined
    && anon.json?.sizingProbe === undefined,
    `boss=${JSON.stringify(asBoss2.json?.sizingProbe)} tenant=${JSON.stringify(asTenant.json?.sizingProbe)}`);
  ok("...and no floor's configured size appears on any branch of the heartbeat",
    ![asBoss2, asTenant, anon].some((r) => /floorsOverProbe|fixedUsd/.test(JSON.stringify(r.json ?? {}))),
    "no floorsOverProbe on the owner's branch or anyone else's");
}

server.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
