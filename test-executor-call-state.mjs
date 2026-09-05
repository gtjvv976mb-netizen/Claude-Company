/**
 * THE EXIT MUST REACH THE BOT EVEN WHEN THE EVENT DOES NOT.
 *
 * Wave 1 made the desk the sole author of exits. Shrek call 55, 2026-09-05: the bot
 * sold at 03:01:42Z on its OWN normalised stop at -13.5%, and the desk's determined
 * stop_hit landed at 03:10:24Z — nine minutes later, on a different number. Removing
 * the bot's stop was exactly what the owner asked for ("all exits should be followed
 * not after or before, but as exactly as it was determined"), and it is precisely why
 * a desk exit that never gets DELIVERED is now unsurvivable rather than merely late:
 * with no stop, no target and no clock of its own, the bot holds for ever.
 *
 * Two ways the single exit event fails to arrive. It is delivered once — alerts has
 * UNIQUE(floor_no, call_id, kind), the feed serves strictly after a durable cursor,
 * and the cursor advances per event, so a bot that restarts or throws on that row
 * never sees it again. And a desk whose penthouse loop is wedged answers the feed 200
 * with no events, which is byte-for-byte identical to "the desk looked and held".
 *
 * This is the DESK half of the floor under that: GET /api/floor/:n/executor/calls,
 * exercised against the real route on a throwaway database. Same constant-time bearer
 * as the feed, bounded by an 'offered' delivery on THIS floor so one floor's secret
 * can never read another's, an exact field list with no wallet on it, 400 for a
 * malformed id list and mere ABSENCE for an id the desk does not know — and, most
 * importantly, READ-ONLY: a monitoring read that could close a call or raise an alert
 * would be a second, unaudited author of exits, which is the one thing this design
 * cannot have. Every assertion prints the actual value.
 */
import os from "node:os";
import path from "node:path";
process.env.CLAUDE_CO_DB = process.env.CLAUDE_CO_DB || path.join(os.tmpdir(), "executor-call-state-test.db");
import fs from "node:fs";
try { fs.rmSync(process.env.CLAUDE_CO_DB); } catch {}

const db = (await import("./src/lib/store.js")).default;
const { bus } = await import("./src/lib/bus.js");
const { openCall, closeCall, liveCalls, getCall, noteEvent, highWaterMark } = await import("./src/calls.js");
const copy = await import("./src/copy.js");
const { startOffice } = await import("./src/office.js");

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const FLOOR = 7;          // the floor whose bot is asking
const OTHER = 8;          // a real second floor, with its own real secret
for (const [n, owner, name] of [[FLOOR, "TenantWa11et111111111111111111111111111111111", "Seventh Floor Capital"],
                                [OTHER, "0therWa11et1111111111111111111111111111111111", "Eighth Floor Partners"]]) {
  db.prepare("UPDATE floors SET state='owned', owner=?, name=?, claimed_at=? WHERE n=?").run(owner, name, Date.now(), n);
}
for (const c of liveCalls()) closeCall(c.id, "test_reset", 1);

let mintSeq = 0;
const publish = (symbol, extra = {}) => openCall({
  mint: `Ca11${String(++mintSeq).padStart(2, "0")}${"1".repeat(38)}`, symbol,
  category: "memecoin", launchpad: "pump.fun", conviction: 60,
  entryRef: 0.0010, stop: 0.00075, target: 0.0021, thesis: "a call the bot will hold",
  invalidation: "volume dies", liqUsd: 120_000, rtLossPct: 1.2, mcapUsd: 400_000, ...extra });

const held = publish("HELD");                     // live, offered to FLOOR, the normal case
const closedQuietly = publish("QUIET");           // closed by the desk, exit alert never landed
const skipped = publish("SKIP");                  // this floor was offered nothing
const neverBroadcast = publish("NONE");           // no delivery row at all
const otherFloors = publish("THEIRS");            // offered to OTHER, never to FLOOR

ok("the held call was offered to floor 7", copy.broadcast(held.id, [FLOOR]).offered === 1);
ok("the quiet call was offered to floor 7", copy.broadcast(closedQuietly.id, [FLOOR]).offered === 1);
ok("the other floor's call was offered to floor 8", copy.broadcast(otherFloors.id, [OTHER]).offered === 1);
db.prepare("INSERT INTO deliveries (call_id,floor_no,verdict,reason,size_sol,delivered_at) VALUES (?,?,?,?,?,?)")
  .run(skipped.id, FLOOR, "skipped", "under this floor's conviction bar", null, Date.now());
closeCall(closedQuietly.id, "stop_hit", 0.00072);
db.prepare("DELETE FROM alerts WHERE call_id=? AND kind='exit'").run(closedQuietly.id);   // the announce that never landed

const secret = copy.settingsFor(FLOOR).executor_secret;
const otherSecret = copy.settingsFor(OTHER).executor_secret;
ok("the two floors have different secrets", Boolean(secret) && Boolean(otherSecret) && secret !== otherSecret,
  `${String(secret).slice(0, 6)}… vs ${String(otherSecret).slice(0, 6)}…`);

const { server } = startOffice(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;
const get = async (ids, { bearer = secret, floor = FLOOR, method = "GET", query = null } = {}) => {
  const qs = query != null ? query : (ids == null ? "" : `?ids=${encodeURIComponent(ids)}`);
  const r = await fetch(`${base}/api/floor/${floor}/executor/calls${qs}`, { method,
    headers: { ...(bearer == null ? {} : { authorization: `Bearer ${bearer}` }),
               ...(method === "POST" ? { "content-type": "application/json" } : {}) },
    body: method === "POST" ? JSON.stringify({ ids: [1] }) : undefined });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json, cache: r.headers.get("cache-control") };
};

console.log("\nTHE STATE READ IS BEHIND THE FLOOR'S OWN SECRET — THE SAME ONE AS THE FEED");
{
  const none = await get(held.id, { bearer: null });
  ok("no bearer is refused", none.status === 401, `HTTP ${none.status}`);
  const wrongSameLen = await get(held.id, { bearer: secret.slice(0, -1) + (secret.endsWith("a") ? "b" : "a") });
  ok("a wrong secret of the right length is refused", wrongSameLen.status === 401, `HTTP ${wrongSameLen.status}`);
  const wrongLen = await get(held.id, { bearer: "short" });
  ok("a wrong secret of the wrong length is refused", wrongLen.status === 401, `HTTP ${wrongLen.status}`);
  const empty = await get(held.id, { bearer: "" });
  ok("an empty bearer is refused", empty.status === 401, `HTTP ${empty.status}`);
  const crossed = await get(otherFloors.id, { floor: OTHER, bearer: secret });
  ok("floor 7's secret does not open floor 8's state read", crossed.status === 401, `HTTP ${crossed.status}`);
  const unleased = await get(held.id, { floor: 3, bearer: secret });
  ok("a floor with no settings row of its own is refused", unleased.status === 401, `HTTP ${unleased.status}`);
  const posted = await get(held.id, { method: "POST" });
  ok("POST is not a state read — 405", posted.status === 405, `HTTP ${posted.status}`);
  const good = await get(held.id);
  ok("the floor's own secret opens it", good.status === 200, `HTTP ${good.status}`);
  ok("...and the answer is never cached: staleness IS the signal", /no-store/.test(good.cache || ""), `cache-control=${good.cache}`);
}

console.log("\nA MALFORMED ids IS 400 — BECAUSE A DROPPED ID WOULD READ AS 'HOLD'");
{
  const bad = [
    ["ids missing entirely", null, null],
    ["ids empty", "", null],
    ["ids all whitespace", "   ", null],
    ["a word", "abc", null],
    ["one good, one word", `${held.id},two`, null],
    ["zero", "0", null],
    ["negative", "-1", null],
    ["a fraction", "1.5", null],
    ["exponent notation", "1e3", null],
    ["hex", "0x2", null],
    ["a trailing comma (an empty id)", `${held.id},`, null],
    ["26 ids", Array.from({ length: 26 }, (_, i) => i + 1).join(","), null],
    ["30 ids that are all the same", Array.from({ length: 30 }, () => held.id).join(","), null],
  ];
  for (const [label, ids, query] of bad) {
    const r = await get(ids, { query: query ?? (ids == null ? "" : `?ids=${encodeURIComponent(ids)}`) });
    ok(`${label} -> 400`, r.status === 400, `HTTP ${r.status}: ${r.json?.error}`);
  }
  const exactly25 = [held.id, ...Array.from({ length: 24 }, (_, i) => 900_000 + i)].join(",");
  const r25 = await get(exactly25);
  ok("exactly 25 ids is accepted, not off-by-one refused", r25.status === 200, `HTTP ${r25.status}`);
  ok("...and answers about the one it actually knows", r25.json?.calls?.length === 1 && r25.json.calls[0].call_id === held.id,
    `${r25.json?.calls?.length} calls: ${JSON.stringify(r25.json?.calls?.map((c) => c.call_id))}`);
  const spaced = await get(` ${held.id} , ${closedQuietly.id} `);
  ok("whitespace around ids is tolerated", spaced.status === 200 && spaced.json?.calls?.length === 2,
    `HTTP ${spaced.status}, ${spaced.json?.calls?.length} calls`);
  const parsed = copy.parseCallStateIds(`${held.id},${held.id},${closedQuietly.id}`);
  ok("parseCallStateIds dedupes", parsed.ok && parsed.ids.length === 2, JSON.stringify(parsed));
}

console.log("\nAN ID THE DESK DOES NOT KNOW IS ABSENT, NEVER AN ERROR — THE BOT HOLDS ON ABSENCE");
{
  const r = await get([held.id, skipped.id, neverBroadcast.id, otherFloors.id, 987_654].join(","));
  ok("the read succeeds", r.status === 200, `HTTP ${r.status}`);
  const got = (r.json?.calls || []).map((c) => c.call_id);
  ok("only the offered call on this floor comes back", got.length === 1 && got[0] === held.id, `ids=${JSON.stringify(got)}`);
  ok("a SKIPPED delivery is absent", !got.includes(skipped.id), `skipped id ${skipped.id}`);
  ok("a call never broadcast to anyone is absent", !got.includes(neverBroadcast.id), `id ${neverBroadcast.id}`);
  ok("another floor's call is absent", !got.includes(otherFloors.id), `id ${otherFloors.id}`);
  ok("an id no call ever had is absent, and still 200", !got.includes(987_654), "id 987654");
}

console.log("\nTHE EXACT FIELD LIST — AND NO WALLET, NO SECRET, NO OTHER FLOOR");
{
  const r = await get(held.id);
  const c = r.json?.calls?.[0];
  ok("the response is {calls, now} and nothing else",
    JSON.stringify(Object.keys(r.json || {}).sort()) === '["calls","now"]', JSON.stringify(Object.keys(r.json || {})));
  /* Pinned as a LITERAL, not as `copy.CALL_STATE_FIELDS`, because comparing the wire to
     the constant that produced it would pass no matter what either one became. The bot
     parses this order; the two halves of the contract have to agree here or nowhere.
     The original fourteen come first and keep their positions — mint and high_water are
     appended, so an older bot reading by name is untouched. */
  const CONTRACT = ["call_id", "status", "close_reason", "close_mark", "closed_at", "opened_at",
    "entry_ref", "stop", "target", "hold_band", "hold_min_ms", "hold_max_ms",
    "last_mark", "last_mark_ts", "mint", "high_water",
    /* The desk's three policy dials. A mirror running bare POLICY_DEFAULTS against a desk
       tuned to DESK_TAKE_PROFIT_X=3 sells a full multiple early — a determination the desk
       never made. Served from the same expressions evaluateExit overrides with. */
    "take_profit_x", "max_age_hours", "trail_pct"];
  ok("the call carries exactly the contracted fields, in order",
    JSON.stringify(Object.keys(c || {})) === JSON.stringify(CONTRACT),
    JSON.stringify(Object.keys(c || {})));
  ok("...and copy.CALL_STATE_FIELDS says the same thing",
    JSON.stringify(copy.CALL_STATE_FIELDS) === JSON.stringify(CONTRACT), JSON.stringify(copy.CALL_STATE_FIELDS));
  ok("...with the first fourteen unmoved, so the two new fields are purely additive",
    JSON.stringify(CONTRACT.slice(0, 14)) === JSON.stringify(["call_id", "status", "close_reason", "close_mark",
      "closed_at", "opened_at", "entry_ref", "stop", "target", "hold_band", "hold_min_ms", "hold_max_ms",
      "last_mark", "last_mark_ts"]), JSON.stringify(CONTRACT.slice(0, 14)));
  const body = JSON.stringify(r.json);
  ok("no key matching /wallet/ anywhere", !/wallet/i.test(body), (body.match(/\w*wallet\w*/gi) || []).join(",") || "none");
  ok("the floor's secret does not appear in the payload", !body.includes(secret));
  ok("still no symbol — the mint is an identity check, not a display string",
    !("symbol" in (c || {})), JSON.stringify(Object.keys(c || {}).filter((k) => /symbol/.test(k))));
  ok("...and the burner-facing tables are not joined in", !/signature|qty_raw|size_sol/.test(body));
}

console.log("\nTHE DESK'S OWN LEVELS, CODE AND CLOCK COME BACK");
{
  const before = Date.now();
  const r = await get([held.id, closedQuietly.id].join(","));
  const after = Date.now();
  const live = r.json.calls.find((c) => c.call_id === held.id);
  const dead = r.json.calls.find((c) => c.call_id === closedQuietly.id);
  const row = getCall(held.id);

  ok("the live call reads live", live.status === "live", `status=${live.status}`);
  ok("...with no close_reason, close_mark or closed_at",
    live.close_reason === null && live.close_mark === null && live.closed_at === null,
    `${live.close_reason} / ${live.close_mark} / ${live.closed_at}`);
  ok("...and the desk's absolute levels, unchanged",
    live.entry_ref === 0.0010 && live.stop === 0.00075 && live.target === 0.0021,
    `entry_ref=${live.entry_ref} stop=${live.stop} target=${live.target}`);
  ok("...and opened_at straight from the calls row", live.opened_at === row.opened_at, `${live.opened_at} vs ${row.opened_at}`);
  ok("...and the band clock the bot must be held to",
    live.hold_band === row.hold_band && live.hold_min_ms === row.hold_min_ms && live.hold_max_ms === row.hold_max_ms,
    `${live.hold_band} ${live.hold_min_ms}/${live.hold_max_ms}`);

  ok("the closed call reads closed", dead.status === "closed", `status=${dead.status}`);
  ok("...with the desk's own code — this is what the bot will sell on",
    dead.close_reason === "stop_hit", `close_reason=${dead.close_reason}`);
  ok("...the desk's close print and moment",
    dead.close_mark === 0.00072 && dead.closed_at === getCall(closedQuietly.id).closed_at,
    `close_mark=${dead.close_mark} closed_at=${dead.closed_at}`);

  ok("'now' is the DESK'S clock, so the bot measures silence against the desk's time",
    Number.isInteger(r.json.now) && r.json.now >= before && r.json.now <= after,
    `now=${r.json.now}, request spanned ${before}..${after}`);
}

console.log("\nlast_mark_ts IS THE STALENESS SIGNAL — AND A CALL THE DESK NEVER MARKED READS STALE FROM BIRTH");
{
  const fresh = (await get(held.id)).json.calls[0];
  const row = getCall(held.id);
  ok("with no mark ever recorded, last_mark_ts falls back to opened_at, never null",
    fresh.last_mark_ts === row.opened_at, `last_mark_ts=${fresh.last_mark_ts} opened_at=${row.opened_at}`);
  ok("...and last_mark falls back to entry_ref", fresh.last_mark === row.entry_ref,
    `last_mark=${fresh.last_mark} entry_ref=${fresh.entry_ref}`);

  noteEvent(held.id, "mark", "monitor pass", 0.00118);
  const marked = (await get(held.id)).json.calls[0];
  const ts1 = db.prepare("SELECT MAX(ts) t FROM call_events WHERE call_id=? AND mark IS NOT NULL").get(held.id).t;
  ok("a recorded mark becomes last_mark", marked.last_mark === 0.00118, `last_mark=${marked.last_mark}`);
  ok("...with the moment the desk recorded it", marked.last_mark_ts === ts1, `last_mark_ts=${marked.last_mark_ts} vs ${ts1}`);

  noteEvent(held.id, "mark", "monitor pass", 0.00091);
  const newer = (await get(held.id)).json.calls[0];
  ok("the LATEST mark wins, not the highest or the first", newer.last_mark === 0.00091, `last_mark=${newer.last_mark}`);

  noteEvent(held.id, "note", "a comment with no price", null);
  const afterNote = (await get(held.id)).json.calls[0];
  ok("an event with no mark does not refresh the staleness clock",
    afterNote.last_mark === 0.00091 && afterNote.last_mark_ts === newer.last_mark_ts,
    `last_mark=${afterNote.last_mark} last_mark_ts=${afterNote.last_mark_ts}`);

  // The whole point, stated as the bot will compute it: a desk that stopped watching
  // eleven minutes ago must be measurable as such from this payload alone.
  db.prepare("UPDATE call_events SET ts=? WHERE call_id=? AND mark IS NOT NULL")
    .run(Date.now() - 11 * 60_000, held.id);
  const stale = (await get(held.id)).json;
  const staleMs = stale.now - stale.calls[0].last_mark_ts;
  ok("a desk silent for 11 minutes measures as 11 minutes of silence",
    staleMs > 10 * 60_000 && staleMs < 12 * 60_000, `${(staleMs / 60_000).toFixed(2)} minutes`);
}

/* THE TWO FIELDS THAT WERE MISSING FROM THE WIRE.
 *
 * mint — the bot sells a TOKEN; this row is keyed by a desk-side integer. Under
 * desk-led exits the bot has no stop and no clock of its own, so whatever this row
 * says about call 55 is what it sells. If its position map ever pairs a call id with
 * the wrong coin — an id reused after a restore, a mis-keyed position, a bug of its
 * own — nothing on the fourteen-field wire could tell it, and it would dump the wrong
 * bag on a stranger's stop. So the row now names the mint and the bot refuses any row
 * whose mint is not the one it is holding.
 *
 * high_water — the desk arms its trail and its breakeven stop off the CONFIRMED high,
 * not off entry. A bot that sees only `stop` cannot reproduce the level the desk is
 * actually watching, and reads a trail exit as a desk firing for no reason. It is the
 * same highWaterMark() the desk's own evaluateExit uses, never a second definition:
 * two definitions of the high is exactly how the bot and the desk came to disagree by
 * nine minutes and 13.5% on Shrek call 55. */
console.log("\nTHE MINT THE BOT MUST MATCH, AND THE DESK'S OWN HIGH-WATER MARK");
{
  const r = await get([held.id, closedQuietly.id].join(","));
  const live = r.json.calls.find((c) => c.call_id === held.id);
  const dead = r.json.calls.find((c) => c.call_id === closedQuietly.id);
  const liveRow = getCall(held.id);
  const deadRow = getCall(closedQuietly.id);

  ok("the live call carries its mint, verbatim from the calls row",
    live.mint === liveRow.mint, `wire=${live.mint} vs calls.mint=${liveRow.mint}`);
  ok("...it is a real base58 mint, not a truncation or an id",
    typeof live.mint === "string" && live.mint.length === liveRow.mint.length && live.mint.length > 30,
    `${live.mint.length} chars`);
  ok("the closed call carries ITS mint, and the two differ",
    dead.mint === deadRow.mint && dead.mint !== live.mint, `${dead.mint} vs ${live.mint}`);
  ok("the mint is not the symbol", live.mint !== liveRow.symbol, `mint=${live.mint} symbol=${liveRow.symbol}`);

  /* The point of the field, stated as the bot will use it: a position holding a
     DIFFERENT mint must be rejectable from this payload alone, with no second lookup. */
  const holding = { callId: held.id, mint: deadRow.mint };            // the bot's map is wrong
  const matched = r.json.calls.find((c) => c.call_id === holding.callId);
  ok("a bot whose position names another mint can refuse this row on the payload alone",
    matched.mint !== holding.mint, `row mint=${matched.mint} vs held mint=${holding.mint}`);

  const hwm = highWaterMark(held.id);
  ok("high_water is exactly highWaterMark(), the desk's own confirmed high",
    live.high_water === hwm, `wire=${live.high_water} vs highWaterMark(${held.id})=${hwm}`);
  ok("...and it is a real number here, not null", Number.isFinite(live.high_water), `high_water=${live.high_water}`);

  /* THE RULER, VALIDATED. The marks recorded on this call are 0.00118 then 0.00091, so
     MAX(mark) is 0.00118 — and highWaterMark's two-witness rule says 0.00091, because a
     single unconfirmed spike must not arm a trail off a price that never traded twice.
     If high_water ever equals the MAX, somebody has re-derived the high on this route
     instead of importing it, which is the whole defect this field exists to avoid. */
  const maxMark = db.prepare("SELECT MAX(mark) m FROM call_events WHERE call_id=? AND mark IS NOT NULL").get(held.id).m;
  ok("high_water is the CONFIRMED high, not MAX(mark) — the two-witness rule, imported not re-derived",
    live.high_water === 0.00091 && maxMark === 0.00118 && live.high_water !== maxMark,
    `high_water=${live.high_water}, MAX(mark)=${maxMark}`);

  ok("a call the desk never marked reports high_water null, not a fabricated level",
    dead.high_water === null && highWaterMark(closedQuietly.id) === null,
    `high_water=${dead.high_water}, highWaterMark(${closedQuietly.id})=${highWaterMark(closedQuietly.id)}`);

  /* One more confirmed mark moves it, so the field tracks the desk rather than freezing
     at whatever it happened to be when the route was written. */
  noteEvent(held.id, "mark", "monitor pass", 0.00140);
  noteEvent(held.id, "mark", "monitor pass", 0.00135);
  const after = (await get(held.id)).json.calls[0];
  ok("a confirmed new high moves high_water, and it still equals highWaterMark()",
    after.high_water === highWaterMark(held.id) && after.high_water === 0.00135 && after.high_water > live.high_water,
    `${live.high_water} -> ${after.high_water} (highWaterMark=${highWaterMark(held.id)})`);
  ok("...and mint did not move with it", after.mint === liveRow.mint, `mint=${after.mint}`);
  ok("...and the two new fields still carry no wallet and no signature",
    !/wallet|signature|qty_raw/i.test(JSON.stringify(after)), JSON.stringify(after).slice(0, 120));
}

console.log("\nCROSS-FLOOR ISOLATION, WITH A REAL SECOND FLOOR AND ITS OWN SECRET");
{
  const bothIds = [held.id, otherFloors.id].join(",");
  const mine = await get(bothIds, { floor: FLOOR, bearer: secret });
  const theirs = await get(bothIds, { floor: OTHER, bearer: otherSecret });
  ok("floor 7 sees only its own call", mine.status === 200 &&
    JSON.stringify(mine.json.calls.map((c) => c.call_id)) === JSON.stringify([held.id]),
    `floor 7 -> ${JSON.stringify(mine.json.calls.map((c) => c.call_id))}`);
  ok("floor 8 sees only its own call", theirs.status === 200 &&
    JSON.stringify(theirs.json.calls.map((c) => c.call_id)) === JSON.stringify([otherFloors.id]),
    `floor 8 -> ${JSON.stringify(theirs.json.calls.map((c) => c.call_id))}`);
  ok("...and the mint floor 7 gets is its own, never floor 8's",
    mine.json.calls[0].mint === getCall(held.id).mint && mine.json.calls[0].mint !== getCall(otherFloors.id).mint,
    `floor 7 mint=${mine.json.calls[0].mint}, floor 8's is ${getCall(otherFloors.id).mint}`);
  ok("...and floor 8 gets floor 8's mint and floor 8's high_water",
    theirs.json.calls[0].mint === getCall(otherFloors.id).mint &&
    theirs.json.calls[0].high_water === highWaterMark(otherFloors.id),
    `mint=${theirs.json.calls[0].mint} high_water=${theirs.json.calls[0].high_water} vs ${highWaterMark(otherFloors.id)}`);
  ok("floor 8's secret on floor 7's URL is 401, not floor 7's data",
    (await get(bothIds, { floor: FLOOR, bearer: otherSecret })).status === 401);
  ok("the library call is bounded the same way, not just the route",
    JSON.stringify(copy.callStateFor(FLOOR, [otherFloors.id]).calls) === "[]" &&
    copy.callStateFor(OTHER, [otherFloors.id]).calls.length === 1,
    `floor 7 asking for ${otherFloors.id}: ${JSON.stringify(copy.callStateFor(FLOOR, [otherFloors.id]).calls)}`);
  ok("callStateFor with no ids answers empty rather than every call",
    copy.callStateFor(FLOOR, []).calls.length === 0 && copy.callStateFor(FLOOR, null).calls.length === 0);
  ok("...and a junk id list cannot smuggle a scan past it",
    copy.callStateFor(FLOOR, ["1 OR 1=1", NaN, -3, 1.5]).calls.length === 0);
}

console.log("\nREAD-ONLY: THE MONITORING READ MUST NOT BECOME A SECOND AUTHOR OF EXITS");
{
  /* The fixture is deliberately the most tempting one there is: a call the desk CLOSED
     with stop_hit whose exit alert never landed. The feed route repairs exactly that
     (reconcileMissingExitAlerts), and repairing it here would have been an easy, wrong
     convenience — a read that writes is a second exit path, and the whole of wave 1 is
     the claim that there is only one. So: byte-identical tables across the read. */
  const snapshot = () => JSON.stringify({
    calls: db.prepare("SELECT * FROM calls ORDER BY id").all(),
    call_events: db.prepare("SELECT * FROM call_events ORDER BY id").all(),
    alerts: db.prepare("SELECT * FROM alerts ORDER BY id").all(),
    deliveries: db.prepare("SELECT * FROM deliveries ORDER BY id").all(),
    executor_fills: db.prepare("SELECT * FROM executor_fills ORDER BY id").all(),
    copy_settings: db.prepare("SELECT * FROM copy_settings ORDER BY floor_no").all(),
  });
  const exitAlerts = () => db.prepare("SELECT COUNT(*) n FROM alerts WHERE floor_no=? AND call_id=? AND kind='exit'")
    .get(FLOOR, closedQuietly.id).n;
  ok("the fixture really is a closed call with no exit alert",
    getCall(closedQuietly.id).status === "closed" && exitAlerts() === 0, `exit alerts=${exitAlerts()}`);

  const events = [];
  const onEvent = (e) => events.push(e?.type ?? "?");
  bus.on("event", onEvent);
  const before = snapshot();
  const r1 = await get([held.id, closedQuietly.id, skipped.id, otherFloors.id, 987_654].join(","));
  const r2 = await get([closedQuietly.id, held.id].join(","));
  copy.callStateFor(FLOOR, [held.id, closedQuietly.id]);
  const after = snapshot();
  bus.off("event", onEvent);

  ok("three reads answered 200", r1.status === 200 && r2.status === 200, `${r1.status} / ${r2.status}`);
  ok("...and they really did carry the two new fields, so this covers them",
    "mint" in r1.json.calls[0] && "high_water" in r1.json.calls[0],
    `mint=${r1.json.calls[0].mint} high_water=${r1.json.calls[0].high_water}`);
  ok("every table is byte-identical before and after", before === after,
    before === after ? `${before.length} bytes unchanged` : "TABLES CHANGED");
  ok("...the closed call was not re-closed or re-stamped",
    JSON.stringify(getCall(closedQuietly.id)) === JSON.stringify(JSON.parse(before).calls.find((c) => c.id === closedQuietly.id)));
  ok("...no exit alert was raised by the read", exitAlerts() === 0, `exit alerts=${exitAlerts()}`);
  ok("...no delivery was marked taken",
    Number(db.prepare("SELECT taken FROM deliveries WHERE floor_no=? AND call_id=?").get(FLOOR, held.id).taken) === 0,
    `taken=${db.prepare("SELECT taken FROM deliveries WHERE floor_no=? AND call_id=?").get(FLOOR, held.id).taken}`);
  ok("...and the desk announced nothing on the bus", events.length === 0, `events=${JSON.stringify(events)}`);

  /* And the contrast that proves the reconcilers were skipped rather than merely
     idle: the SAME missing alert, on the SAME call, is repaired the moment the bot
     polls the feed. The state read is the floor under that path, not a copy of it. */
  const feed = await fetch(`${base}/api/floor/${FLOOR}/executor/feed?after=0`, { headers: { authorization: `Bearer ${secret}` } });
  ok("the feed poll repaired the very alert the state read left alone",
    feed.status === 200 && exitAlerts() === 1, `HTTP ${feed.status}, exit alerts now ${exitAlerts()}`);
}

console.log("\nTHE ROUTE IS ADDITIVE — THE FEED IT BACKSTOPS IS UNCHANGED");
{
  const r = await fetch(`${base}/api/floor/${FLOOR}/executor/feed?after=0`, { headers: { authorization: `Bearer ${secret}` } });
  const feed = await r.json();
  ok("the feed still serves its usual shape", r.status === 200 && Array.isArray(feed.events) && "latest_id" in feed && "rules" in feed,
    `HTTP ${r.status}, ${feed.events?.length} events, latest_id=${feed.latest_id}`);
  const exit = feed.events.find((e) => e.call_id === closedQuietly.id && e.type === "exit");
  ok("...including the exit event with close_mark and closed_at", exit?.close_mark === 0.00072 && Number(exit?.closed_at) > 0,
    `close_mark=${exit?.close_mark} closed_at=${exit?.closed_at}`);
  const src = fs.readFileSync(new URL("./src/office.js", import.meta.url), "utf8");
  const from = src.indexOf("executor\\/calls$");
  const to = src.indexOf("executor\\/heartbeat$", from);
  ok("the calls route was found in office.js, ahead of the heartbeat route", from > 0 && to > from, `chars ${from}..${to}`);
  const block = src.slice(from, to);
  ok("the calls route's own code contains no reconcile and no write verb",
    !/reconcileMissing|markTaken|closeCall|INSERT|UPDATE|DELETE/.test(block),
    (block.match(/reconcileMissing|markTaken|closeCall|INSERT|UPDATE|DELETE/g) || []).join(",") || "none");
}

server.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
