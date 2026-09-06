/**
 * CONSENT BEFORE INTEREST — the record behind "HQ runs it for you".
 *
 * A tenant clicking a radio button is not evidence that anyone read what a managed
 * track would mean, and the one fact in it that matters — this operator would hold
 * the key and could move the money — is the fact people skim. So asking for that
 * track is gated on an acknowledgement of a disclosure, and the acknowledgement is a
 * ROW: floor, wallet, version, the SHA-256 of the exact words shown, when, and
 * whether it is still current.
 *
 * The assertions here are the ways that record could quietly become worthless:
 *
 *   - the hash drifting from the words, so a stored signature certifies a paragraph
 *     nobody ever saw (re-hashed here from the served text, not trusted);
 *   - the gate not gating, so the demand number counts clicks by people who were
 *     told nothing;
 *   - a changed disclosure leaving old acknowledgements looking current, which is
 *     how unprovable acceptance happens;
 *   - the acknowledgement PROVISIONING something — the whole database is snapshotted
 *     around it, because a flow that created a wallet or took a deposit would be the
 *     one failure this feature exists to prevent;
 *   - a process credential (the executor secret) or another wallet being able to
 *     consent to custody on the tenant's behalf;
 *   - withdrawal being harder to do than consent was.
 *
 * Every assertion prints the value it read.
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

process.env.CLAUDE_CO_DB = process.env.CLAUDE_CO_DB || path.join(os.tmpdir(), "hq-consent-test.db");
try { fs.rmSync(process.env.CLAUDE_CO_DB); } catch {}

/* Real ed25519 keypairs and a real sign-in, so the wallet-session gate is exercised
   the way a browser exercises it rather than by forging a session row. The HQ deed is
   set before tower.js is imported because tower asserts it on boot. */
const { encode } = await import("./src/lib/base58.js");
function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { wallet: encode(raw), privateKey };
}
const tenant = keypair();
const stranger = keypair();
const boss = keypair();
process.env.HQ_OWNER_WALLET = boss.wallet;

const db = (await import("./src/lib/store.js")).default;
const auth = await import("./src/auth.js");
await import("./src/tower.js");
const copy = await import("./src/copy.js");
const { startOffice } = await import("./src/office.js");

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const FLOOR = 21, OTHER = 22;

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
lease(FLOOR, tenant.wallet, "Twenty-first Floor");
lease(OTHER, stranger.wallet, "Twenty-second Floor");
const token = signIn(tenant), tokenStranger = signIn(stranger), tokenBoss = signIn(boss);

const { server } = startOffice(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;

const hit = async (pathname, { token: t = token, method = "GET", body, raw } = {}) => {
  const r = await fetch(`${base}${pathname}`, { method,
    headers: { "content-type": "application/json", ...(t == null ? {} : { authorization: `Bearer ${t}` }) },
    body: method === "POST" ? (raw ?? JSON.stringify(body ?? {})) : undefined });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
};
const consentApi = (floor = FLOOR, opts) => hit(`/api/floor/${floor}/hq-consent`, opts);
const operatorApi = (floor = FLOOR, opts) => hit(`/api/floor/${floor}/bot-operator`, opts);
const opRow = (floor = FLOOR) =>
  db.prepare("SELECT bot_operator, bot_operator_at, hq_requested_at FROM copy_settings WHERE floor_no=?").get(floor);
const consentRows = (floor = FLOOR) =>
  db.prepare("SELECT * FROM hq_consents WHERE floor_no=? ORDER BY id").all(floor);

/** Every table, every row, as text — the same blunt instrument the operator-choice
 *  test uses. A consent flow that minted a wallet, opened a deposit or queued a
 *  delivery would show up here as a table that changed, whatever it was named. */
const TABLES = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((t) => t.name);
const snapshot = () => {
  const out = {};
  for (const t of TABLES) { try { out[t] = JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all()); } catch (e) { out[t] = `ERR ${e.message}`; } }
  return out;
};
const diffTables = (a, b) => Object.keys(a).filter((t) => a[t] !== b[t]);

console.log("\nTHE HASH IS TAKEN OVER THE WORDS ON SCREEN");
{
  const g = await consentApi();
  ok("the floor's owner can read the disclosure", g.status === 200, `HTTP ${g.status}`);
  const d = g.json?.disclosure;
  ok("...it carries a version, a hash and the text itself",
    typeof d?.version === "string" && /^[0-9a-f]{64}$/.test(d?.sha256 || "") && (d?.text || "").length > 800,
    `version=${d?.version} sha256=${d?.sha256} textLength=${d?.text?.length}`);
  /* THE CENTRAL CLAIM. Re-hash the served bytes here; if the server ever computed its
     hash from a different source than the text it serves, this is where it shows. */
  const fresh = crypto.createHash("sha256").update(d?.text ?? "", "utf8").digest("hex");
  ok("a fresh SHA-256 of the served text equals the served hash", fresh === d?.sha256,
    `served=${d?.sha256} fresh=${fresh}`);
  ok("...and the exported module data hashes the same",
    copy.hqDisclosure().sha256 === fresh && copy.hqDisclosure().text === d?.text,
    `module=${copy.hqDisclosure().sha256} served=${d?.sha256} sameText=${copy.hqDisclosure().text === d?.text}`);
  ok("all eight conditions are served as structured data too", (d?.conditions || []).length === 8,
    `conditions=${(d?.conditions || []).map((c) => c.n).join(",")}`);
  /* The page renders these words; if the structure and the hashed text disagreed, the
     screen and the signature would be about different documents. */
  const missingFromText = (d?.conditions || []).filter((c) => !d.text.includes(c.heading)
    || c.points.some((p) => !d.text.includes(p)));
  ok("...and every heading and sentence in them appears in the hashed text",
    missingFromText.length === 0, `missing=${missingFromText.map((c) => c.n).join(",") || "none"}`);
  ok("nobody has acknowledged anything yet", g.json?.consent?.acknowledged === false && (g.json?.history || []).length === 0,
    `acknowledged=${g.json?.consent?.acknowledged} history=${(g.json?.history || []).length} rows`);
}

console.log("\nTHE MEASURED FACTS SURVIVED THE EDIT, AND THE LAWYER'S JOB IS NOT BEING DONE HERE");
{
  const text = copy.hqDisclosure().text;
  const musts = [
    ["custody stated plainly", /private key would be held by us/i],
    ["...and the recourse it costs", /ability to move them would depend on us/i],
    ["the desk picks the trades", /choose what to buy and when to sell/i],
    ["39 starts and 33 stops", /39 starts and 33 stops/],
    ["38 sleep-related events", /38 sleep-related events/],
    ["out of paid credit for over a day", /out of paid credit[\s\S]{0,60}over a day/i],
    ["55 calls, 26 up, 28 down", /55 calls[\s\S]{0,40}26 up and 28 down/i],
    ["2 settled trades, realised P&L negative", /2 settled trades and realised P&L negative/i],
    ["the site's own line about the record", /too few to claim an edge/i],
    ["the whole balance can go", /take the whole balance/i],
    ["withdrawal is unbuilt, not slow", /not slow — it is unbuilt/i],
    ["it does not exist yet", /Nothing is being managed today/i],
    ["a real agreement comes first", /real agreement/i],
    ["and this is not it", /This is not the agreement/i],
  ];
  for (const [label, re] of musts) {
    const m = text.match(re);
    ok(label, !!m, m ? `"${String(m[0]).slice(0, 72).replace(/\n/g, " ")}"` : "NOT FOUND");
  }
  /* The spec forbids clause-shaped language: this is a disclosure, and dressing it as
     a contract would let it be mistaken for the agreement that still has to be
     drafted. Also forbidden, and far worse: anything that could take money. */
  const banned = [/\bhereby\b/i, /\bthe parties\b/i, /\bindemnif/i, /\bwarrant\b/i, /agree to be bound/i];
  const hits = banned.filter((re) => re.test(text)).map((re) => String(re));
  ok("no clause-shaped legal language", hits.length === 0, `hits=[${hits.join(", ")}]`);
  const addressish = text.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g);
  ok("no address-shaped string anywhere in it — nothing to pay into",
    addressish === null, `found=${JSON.stringify(addressish)}`);
  ok("...and it says out loud that it takes no deposit and creates no wallet",
    /takes no deposit, creates no wallet/i.test(text),
    `"${(text.match(/takes no deposit[^.]*\./i) || ["NOT FOUND"])[0]}"`);
}

console.log("\nWITHOUT AN ACKNOWLEDGEMENT, 'hq_requested' IS REFUSED");
{
  /* Open the panel first. A floor's copy_settings row is created lazily on the first
     read, so snapshotting before that would compare an insert against an absence and
     the "nothing changed" assertion below would fail for a reason that has nothing to
     do with consent. */
  const opened = await operatorApi(FLOOR, {});
  ok("the panel opens with no choice made", opened.json?.botOperator === null,
    `botOperator=${JSON.stringify(opened.json?.botOperator)}`);
  const before = snapshot();
  const r = await operatorApi(FLOOR, { method: "POST", body: { choice: "hq_requested" } });
  ok("the route refuses", r.status === 409, `HTTP ${r.status}: ${r.json?.error}`);
  ok("...saying what is missing, not 'invalid value'",
    r.json?.needsAcknowledgement === true && /acknowledge the disclosure/i.test(r.json?.error || ""),
    `needsAcknowledgement=${r.json?.needsAcknowledgement} error="${r.json?.error}"`);
  ok("...and handing back the version and hash to show",
    r.json?.disclosure?.sha256 === copy.hqDisclosure().sha256,
    `disclosure.sha256=${r.json?.disclosure?.sha256}`);
  ok("nothing was stored", opRow()?.bot_operator == null && consentRows().length === 0,
    `bot_operator=${JSON.stringify(opRow()?.bot_operator)} consentRows=${consentRows().length}`);
  const changed = diffTables(before, snapshot());
  ok("...in any table", changed.length === 0, `changed=[${changed.join(", ")}] of ${TABLES.length}`);
  /* 'self' needs no disclosure: being told your own machine keeps your own key is not
     a risk anyone has to acknowledge. If this ever 409s, the gate is too wide. */
  const s = await operatorApi(FLOOR, { method: "POST", body: { choice: "self" } });
  ok("'self' is unaffected by the gate", s.status === 200 && s.json?.botOperator === "self",
    `HTTP ${s.status} botOperator=${s.json?.botOperator}`);
  ok("...and the direct call refuses too, not only the route",
    copy.setBotOperator(FLOOR, "hq_requested").ok === false,
    JSON.stringify(copy.setBotOperator(FLOOR, "hq_requested")).slice(0, 160));
}

console.log("\nCONSENT TO CUSTODY IS A PERSON'S ACT: A PROCESS CREDENTIAL CANNOT GIVE IT");
{
  const secret = copy.settingsFor(FLOOR).executor_secret;
  ok("the floor has an executor secret to try", typeof secret === "string" && secret.length >= 32,
    `length=${secret?.length}`);
  const d = copy.hqDisclosure();
  const body = { action: "acknowledge", version: d.version, sha256: d.sha256, conditions: [1, 2, 3, 4, 5, 6, 7, 8] };
  const asBot = await consentApi(FLOOR, { method: "POST", token: secret, body });
  ok("the executor secret is refused", asBot.status === 401, `HTTP ${asBot.status}: ${asBot.json?.error}`);
  const anon = await consentApi(FLOOR, { method: "POST", token: null, body });
  ok("no bearer at all is refused", anon.status === 401, `HTTP ${anon.status}`);
  const other = await consentApi(FLOOR, { method: "POST", token: tokenStranger, body });
  ok("another wallet cannot acknowledge for this floor", other.status === 403,
    `HTTP ${other.status}: ${other.json?.error}`);
  const boss1 = await consentApi(FLOOR, { method: "POST", token: tokenBoss, body });
  ok("...not even the building's owner", boss1.status === 403, `HTTP ${boss1.status}`);
  const readAsBot = await consentApi(FLOOR, { token: secret });
  ok("the executor secret cannot even read the disclosure route", readAsBot.status === 401,
    `HTTP ${readAsBot.status}`);
  ok("no consent row was written by any of those", consentRows().length === 0,
    `rows=${consentRows().length}`);
}

console.log("\nA HALF-READ OR STALE ACKNOWLEDGEMENT IS REFUSED AND WRITES NOTHING");
{
  const d = copy.hqDisclosure();
  const all = [1, 2, 3, 4, 5, 6, 7, 8];
  const cases = [
    ["a hash from other words", { action: "acknowledge", version: d.version, sha256: crypto.createHash("sha256").update("other words").digest("hex"), conditions: all }, 409],
    ["a version that is not current", { action: "acknowledge", version: "1999-01-01.1", sha256: d.sha256, conditions: all }, 409],
    ["no hash at all", { action: "acknowledge", version: d.version, conditions: all }, 409],
    ["seven of the eight conditions", { action: "acknowledge", version: d.version, sha256: d.sha256, conditions: [1, 2, 3, 4, 5, 6, 7] }, 400],
    ["one blanket tick", { action: "acknowledge", version: d.version, sha256: d.sha256, conditions: [1] }, 400],
    ["no conditions", { action: "acknowledge", version: d.version, sha256: d.sha256 }, 400],
    ["an unknown action", { action: "sure", version: d.version, sha256: d.sha256, conditions: all }, 400],
    ["no action", { version: d.version, sha256: d.sha256, conditions: all }, 400],
  ];
  for (const [label, body, want] of cases) {
    const r = await consentApi(FLOOR, { method: "POST", body });
    ok(`${label} -> ${want}`, r.status === want, `HTTP ${r.status}: ${r.json?.error}`);
  }
  const seven = await consentApi(FLOOR, { method: "POST", body: { action: "acknowledge", version: d.version, sha256: d.sha256, conditions: [1, 2, 3, 4, 5, 6, 7] } });
  ok("...and the refusal names the condition that was skipped",
    JSON.stringify(seven.json?.missing) === "[8]", `missing=${JSON.stringify(seven.json?.missing)}`);
  const notJson = await consentApi(FLOOR, { method: "POST", raw: "{not json" });
  ok("a body that is not JSON -> 400", notJson.status === 400, `HTTP ${notJson.status}`);
  const put = await consentApi(FLOOR, { method: "PUT", body: { action: "acknowledge" } });
  ok("PUT is not an acknowledgement -> 405", put.status === 405, `HTTP ${put.status}`);
  ok("still nothing in the consent table", consentRows().length === 0, `rows=${consentRows().length}`);
}

console.log("\nACKNOWLEDGING WRITES ONE ROW AND PROVISIONS NOTHING");
let firstSha = null, firstAt = null;
{
  const d = copy.hqDisclosure();
  firstSha = d.sha256;
  const before = snapshot();
  const at = Date.now();
  const r = await consentApi(FLOOR, { method: "POST", body: { action: "acknowledge", version: d.version, sha256: d.sha256, conditions: [1, 2, 3, 4, 5, 6, 7, 8] } });
  ok("the acknowledgement is accepted", r.status === 200 && r.json?.ok === true, `HTTP ${r.status}`);
  ok("...and reads back as acknowledged and not stale",
    r.json?.consent?.acknowledged === true && r.json?.consent?.stale === false,
    `acknowledged=${r.json?.consent?.acknowledged} stale=${r.json?.consent?.stale}`);
  const rows = consentRows();
  ok("...one row, marked current", rows.length === 1 && rows[0].current === 1,
    `rows=${rows.length} current=${rows[0]?.current}`);
  const row = rows[0];
  firstAt = row.created_at;
  ok("...carrying the floor, the wallet, the version and the hash of the words shown",
    row.floor_no === FLOOR && row.wallet === tenant.wallet && row.version === d.version
    && row.disclosure_sha256 === d.sha256,
    `floor=${row.floor_no} wallet=${row.wallet.slice(0, 8)}… version=${row.version} sha=${row.disclosure_sha256.slice(0, 16)}…`);
  ok("...and the moment it happened", Number(row.created_at) >= at && Number(row.created_at) <= Date.now(),
    `created_at=${row.created_at}`);
  ok("...with which conditions were ticked", JSON.stringify(JSON.parse(row.conditions)) === "[1,2,3,4,5,6,7,8]",
    `conditions=${row.conditions}`);
  /* NO PERSONAL DATA BEYOND THE WALLET THE SESSION ALREADY CARRIES. Named columns,
     because "we did not mean to collect any" is not a check. */
  const cols = Object.keys(row).sort().join(",");
  ok("...and no column beyond that record",
    cols === "action,conditions,created_at,current,disclosure_sha256,floor_no,id,version,wallet",
    `columns=${cols}`);

  /* THE PROVISIONING CHECK. Everything a managed track would have needed to create is
     in one of these tables; only the consent trail may move. */
  const changed = diffTables(before, snapshot());
  ok("ONLY hq_consents changed in the entire database", changed.length === 1 && changed[0] === "hq_consents",
    `changed=[${changed.join(", ")}] of ${TABLES.length} tables`);
  ok("...the floor's operator choice did not move: consent is not the request",
    opRow()?.bot_operator === "self", `bot_operator=${JSON.stringify(opRow()?.bot_operator)}`);
  ok("...no deliveries were created", db.prepare("SELECT COUNT(*) n FROM deliveries").get().n === 0,
    `deliveries=${db.prepare("SELECT COUNT(*) n FROM deliveries").get().n}`);
  ok("...no fills, no ledger row", db.prepare("SELECT COUNT(*) n FROM executor_fills").get().n === 0,
    `executor_fills=${db.prepare("SELECT COUNT(*) n FROM executor_fills").get().n}`);
  const st = copy.settingsFor(FLOOR);
  ok("...no wallet, url or heartbeat appeared for this floor",
    st.executor_url == null && st.executor_heartbeat == null,
    `executor_url=${JSON.stringify(st.executor_url)} heartbeat=${JSON.stringify(st.executor_heartbeat)}`);
}

console.log("\nWITH THE ACKNOWLEDGEMENT, THE INTEREST IS RECORDED");
{
  const before = snapshot();
  const at = Date.now();
  const r = await operatorApi(FLOOR, { method: "POST", body: { choice: "hq_requested" } });
  ok("'hq_requested' is now accepted", r.status === 200 && r.json?.botOperator === "hq_requested",
    `HTTP ${r.status} botOperator=${r.json?.botOperator}`);
  ok("...the column says so", opRow()?.bot_operator === "hq_requested", `column=${opRow()?.bot_operator}`);
  ok("...with the first-ask timestamp", Number(opRow()?.hq_requested_at) >= at,
    `hq_requested_at=${opRow()?.hq_requested_at}`);
  const changed = diffTables(before, snapshot());
  ok("...and asking still provisions nothing: only copy_settings moved",
    changed.length === 1 && changed[0] === "copy_settings", `changed=[${changed.join(", ")}]`);
  ok("...no second consent row was written by the request",
    consentRows().length === 1, `rows=${consentRows().length}`);
  const g = await operatorApi(FLOOR, {});
  ok("the operator route carries the consent summary the panel needs",
    g.json?.consent?.acknowledged === true && g.json?.consent?.sha256 === firstSha
    && g.json?.disclosure?.sha256 === firstSha,
    `consent.acknowledged=${g.json?.consent?.acknowledged} consent.sha256=${String(g.json?.consent?.sha256).slice(0, 16)}… disclosure.sha256=${String(g.json?.disclosure?.sha256).slice(0, 16)}…`);
  const dem = copy.hqOperatorDemand();
  ok("the demand count sees one floor, and it is CURRENT interest",
    dem.requested === 1 && dem.currentInterest === 1 && dem.staleInterest === 0,
    `requested=${dem.requested} current=${dem.currentInterest} stale=${dem.staleInterest}`);
}

console.log("\nCHANGE THE WORDS AND THE OLD ACKNOWLEDGEMENT STOPS COUNTING");
{
  /* The same call a real version bump makes — the text is rendered and hashed by the
     module, never pasted in, so the new hash cannot drift from the new words either. */
  const v2 = copy.publishHqDisclosure({
    version: "2026-09-06.2-test",
    title: "If HQ ran your bot — what that would mean",
    intro: ["This is not the agreement, and nothing here holds your money. It takes no deposit, creates no wallet for you, and changes nothing about how your floor trades today."],
    conditions: copy.hqDisclosure().conditions.map((c) => (c.n === 3
      ? { n: 3, heading: c.heading, points: [...c.points, "One added sentence, so the words are not the words that were acknowledged."] }
      : { n: c.n, heading: c.heading, points: [...c.points] })),
    closing: ["Ticking every box records that you read these facts and accept them as they stand."],
  });
  ok("a new version publishes with a different hash", v2.sha256 !== firstSha,
    `was ${firstSha.slice(0, 16)}… now ${v2.sha256.slice(0, 16)}…`);
  ok("...and it is what the route now serves",
    (await consentApi()).json?.disclosure?.sha256 === v2.sha256, `served=${(await consentApi()).json?.disclosure?.sha256.slice(0, 16)}…`);
  const fresh = crypto.createHash("sha256").update((await consentApi()).json?.disclosure?.text ?? "", "utf8").digest("hex");
  ok("...still hashing to a fresh SHA-256 of its own served text", fresh === v2.sha256,
    `served=${v2.sha256} fresh=${fresh}`);

  const c = copy.hqConsentFor(FLOOR);
  ok("the earlier acknowledgement is now STALE, not acknowledged",
    c.acknowledged === false && c.stale === true, `acknowledged=${c.acknowledged} stale=${c.stale}`);
  ok("...and it still says which words it was over — the trail is intact",
    c.sha256 === firstSha && consentRows().length === 1 && consentRows()[0].created_at === firstAt,
    `row.sha=${c.sha256.slice(0, 16)}… rows=${consentRows().length}`);
  const dem = copy.hqOperatorDemand();
  ok("demand tells current interest from stale",
    dem.requested === 1 && dem.currentInterest === 0 && dem.staleInterest === 1,
    `requested=${dem.requested} current=${dem.currentInterest} stale=${dem.staleInterest}`);
  ok("...and names the disclosure it is counting against",
    dem.disclosureSha256 === v2.sha256 && dem.disclosureVersion === v2.version,
    `version=${dem.disclosureVersion} sha=${String(dem.disclosureSha256).slice(0, 16)}…`);

  const stale = await operatorApi(FLOOR, { method: "POST", body: { choice: "hq_requested" } });
  ok("re-asking under the old acknowledgement is refused", stale.status === 409,
    `HTTP ${stale.status}: ${stale.json?.error}`);
  ok("...and says it is because the words changed", stale.json?.staleAcknowledgement === true,
    `staleAcknowledgement=${stale.json?.staleAcknowledgement}`);
  const old = await consentApi(FLOOR, { method: "POST", body: { action: "acknowledge", version: "2026-09-06.1", sha256: firstSha, conditions: [1, 2, 3, 4, 5, 6, 7, 8] } });
  ok("acknowledging the OLD text is refused", old.status === 409, `HTTP ${old.status}: ${old.json?.error}`);

  const r = await consentApi(FLOOR, { method: "POST", body: { action: "acknowledge", version: v2.version, sha256: v2.sha256, conditions: [1, 2, 3, 4, 5, 6, 7, 8] } });
  ok("acknowledging the new text is accepted", r.status === 200 && r.json?.consent?.acknowledged === true,
    `HTTP ${r.status} acknowledged=${r.json?.consent?.acknowledged}`);
  const rows = consentRows();
  ok("...as a SECOND row: the first was superseded, not edited",
    rows.length === 2 && rows[0].disclosure_sha256 === firstSha && rows[0].current === 0
    && rows[1].disclosure_sha256 === v2.sha256 && rows[1].current === 1,
    `rows=${rows.map((x) => `${x.action}/${x.disclosure_sha256.slice(0, 8)}/current=${x.current}`).join(" ")}`);
  const dem2 = copy.hqOperatorDemand();
  ok("...and the interest counts as current again",
    dem2.currentInterest === 1 && dem2.staleInterest === 0,
    `current=${dem2.currentInterest} stale=${dem2.staleInterest}`);
}

console.log("\nWITHDRAWING IS ONE CLICK, AND IT IS RECORDED TOO");
{
  const firstAsk = opRow()?.hq_requested_at;
  const before = snapshot();
  const w = await consentApi(FLOOR, { method: "POST", body: { action: "withdraw" } });
  ok("the withdrawal is accepted", w.status === 200 && w.json?.withdrawn === true,
    `HTTP ${w.status} withdrawn=${w.json?.withdrawn}`);
  ok("...the consent is no longer current", w.json?.consent?.acknowledged === false,
    `acknowledged=${w.json?.consent?.acknowledged}`);
  ok("...and the interest is cleared, back to undecided rather than to 'self'",
    opRow()?.bot_operator === null && w.json?.botOperator === null,
    `column=${JSON.stringify(opRow()?.bot_operator)} response=${JSON.stringify(w.json?.botOperator)}`);
  ok("...the first-ask date survives, because demand is read over time",
    opRow()?.hq_requested_at === firstAsk, `hq_requested_at=${opRow()?.hq_requested_at} was ${firstAsk}`);
  const rows = consentRows();
  ok("...the withdrawal is its own row, and no row was deleted",
    rows.length === 3 && rows[2].action === "withdrawn" && rows[2].wallet === tenant.wallet
    && rows.every((r) => r.current === 0),
    `rows=${rows.map((r) => `${r.action}/current=${r.current}`).join(" ")}`);
  const changed = diffTables(before, snapshot());
  ok("...touching only the consent trail and the floor's own settings row",
    changed.sort().join(",") === "copy_settings,hq_consents", `changed=[${changed.join(", ")}]`);
  const dem = copy.hqOperatorDemand();
  ok("...and the demand count drops", dem.requested === 0 && dem.currentInterest === 0,
    `requested=${dem.requested} current=${dem.currentInterest}`);

  const again = await operatorApi(FLOOR, { method: "POST", body: { choice: "hq_requested" } });
  ok("asking again after a withdrawal needs a fresh acknowledgement", again.status === 409,
    `HTTP ${again.status}: ${again.json?.error}`);
  const twice = await consentApi(FLOOR, { method: "POST", body: { action: "withdraw" } });
  ok("a second withdrawal is not an error and writes no row",
    twice.status === 200 && twice.json?.withdrawn === false && consentRows().length === 3,
    `HTTP ${twice.status} withdrawn=${twice.json?.withdrawn} rows=${consentRows().length}`);
  const notMine = await consentApi(FLOOR, { method: "POST", token: tokenStranger, body: { action: "withdraw" } });
  ok("another wallet cannot withdraw this floor's consent", notMine.status === 403, `HTTP ${notMine.status}`);
}

console.log("\nONE FLOOR'S CONSENT IS ITS OWN");
{
  const d = copy.hqDisclosure();
  const r = await consentApi(OTHER, { method: "POST", token: tokenStranger, body: { action: "acknowledge", version: d.version, sha256: d.sha256, conditions: [1, 2, 3, 4, 5, 6, 7, 8] } });
  ok("the other floor's owner acknowledges on their own floor", r.status === 200, `HTTP ${r.status}`);
  ok("...which does not acknowledge anything for floor 21",
    copy.hqConsentFor(FLOOR).acknowledged === false && copy.hqConsentFor(OTHER).acknowledged === true,
    `floor${FLOOR}=${copy.hqConsentFor(FLOOR).acknowledged} floor${OTHER}=${copy.hqConsentFor(OTHER).acknowledged}`);
  const mine = await consentApi(FLOOR, {});
  ok("...and floor 21's history shows only its own three rows",
    (mine.json?.history || []).length === 3
    && (mine.json?.history || []).every((h) => h.wallet === tenant.wallet),
    `history=${(mine.json?.history || []).map((h) => h.action).join(",")}`);
  const dem = copy.hqOperatorDemand();
  ok("an acknowledgement on its own is not demand", dem.requested === 0,
    `requested=${dem.requested} current=${dem.currentInterest}`);
}

server.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
