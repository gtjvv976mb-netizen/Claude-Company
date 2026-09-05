/**
 * THE SITE SHOWS THE BOT'S REAL BOOK, OR IT SHOWS A STORY.
 *
 * Shrek call 55, 2026-09-05. The bot filled 0.0175 SOL; the board showed the desk's
 * paper 0.4 SOL. The bot sold at 03:01:42Z on its own normalised stop at -13.5%; the
 * site never heard it, and when the desk's own stop_hit landed at 03:10:24Z the card
 * was still calling the position held. The only executor fact the desk ever stored
 * was the `taken` bit, which cannot carry a size, a price, an exit or a reason.
 *
 * This is the desk side of the fix, exercised against the REAL route on a throwaway
 * database: POST /api/floor/:n/executor/fill behind the same constant-time secret as
 * the feed, 400/404/200 with the semantics the bot's retry queue depends on, an upsert
 * keyed by the chain signature, a buy that marks the delivery taken, a sell that flips
 * the row to closed even while the desk's call is live, bot_* fields on every feed
 * row and the wallet on none of them — and the exit-alert repair sweep, because under
 * desk-led exits a lost exit alert is a position with no exit at all.
 */
import os from "node:os";
import path from "node:path";
process.env.CLAUDE_CO_DB = process.env.CLAUDE_CO_DB || path.join(os.tmpdir(), "executor-fill-report-test.db");
import fs from "node:fs";
try { fs.rmSync(process.env.CLAUDE_CO_DB); } catch {}

const db = (await import("./src/lib/store.js")).default;
const { bus } = await import("./src/lib/bus.js");
const { openCall, closeCall, liveCalls, getCall } = await import("./src/calls.js");
const alerts = await import("./src/alerts.js");
const copy = await import("./src/copy.js");
const { startOffice, executorFeedPayload } = await import("./src/office.js");

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const FLOOR = 7;
const WALLET = "Bot8urner1111111111111111111111111111111111";
const SIG_BUY = "3" + "x".repeat(87);            // 88 base58 chars, like a real Solana signature
const SIG_SELL = "4" + "y".repeat(87);
db.prepare("UPDATE floors SET state='owned', owner=?, name=?, claimed_at=? WHERE n=?")
  .run("TenantWa11et111111111111111111111111111111111", "Seventh Floor Capital", Date.now(), FLOOR);
for (const c of liveCalls()) closeCall(c.id, "test_reset", 1);

const publish = (mint, symbol, extra = {}) => {
  const call = openCall({ mint, symbol, category: "memecoin", launchpad: "pump.fun", conviction: 60,
    entryRef: 0.0010, stop: 0.00075, target: 0.0021, thesis: "a call the bot will trade",
    invalidation: "volume dies", liqUsd: 120_000, rtLossPct: 1.2, mcapUsd: 400_000, ...extra });
  return call;
};
const call = publish("Fi11Ca1111111111111111111111111111111111111", "FILL");
const res = copy.broadcast(call.id, [FLOOR]);
ok("the call was offered to the floor", res.ok && res.offered === 1, `offered=${res.offered}`);
const orphan = publish("Orphan11111111111111111111111111111111111111", "ORPH");   // never broadcast

const secret = copy.settingsFor(FLOOR).executor_secret;
const { server } = startOffice(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;
const post = async (body, { bearer = secret, method = "POST", floor = FLOOR, raw = null } = {}) => {
  const r = await fetch(`${base}/api/floor/${floor}/executor/fill`, { method,
    headers: { "content-type": "application/json", ...(bearer == null ? {} : { authorization: `Bearer ${bearer}` }) },
    body: method === "POST" ? (raw ?? JSON.stringify(body)) : undefined });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
};
const buyBody = { callId: call.id, side: "buy", signature: SIG_BUY, wallet: WALLET, at: Date.now() - 60_000,
  sizeSol: 0.0175, lamportsIn: 17_500_000, qtyRaw: "491380826", entryMark: 0.00102, solUsd: 205.5, intentId: "int-1" };

console.log("\nTHE ROUTE IS BEHIND THE FLOOR'S OWN SECRET");
{
  const none = await post(buyBody, { bearer: null });
  ok("no bearer is refused", none.status === 401, `HTTP ${none.status}`);
  const wrongSameLen = await post(buyBody, { bearer: secret.slice(0, -1) + (secret.endsWith("a") ? "b" : "a") });
  ok("a wrong secret of the right length is refused", wrongSameLen.status === 401, `HTTP ${wrongSameLen.status}`);
  const wrongLen = await post(buyBody, { bearer: "short" });
  ok("a wrong secret of the wrong length is refused", wrongLen.status === 401, `HTTP ${wrongLen.status}`);
  const otherFloor = await post(buyBody, { floor: 8 });
  ok("floor 7's secret does not open floor 8", otherFloor.status === 401, `HTTP ${otherFloor.status}`);
  const get = await post(null, { method: "GET" });
  ok("GET is not a report", get.status === 405, `HTTP ${get.status}`);
  ok("nothing was written by any of those", db.prepare("SELECT COUNT(*) n FROM executor_fills").get().n === 0,
    `${db.prepare("SELECT COUNT(*) n FROM executor_fills").get().n} rows`);
}

console.log("\nA MALFORMED REPORT IS 400, NOT A ROW OF NaN ON THE PUBLIC BOARD");
{
  const cases = [
    ["callId 0", { ...buyBody, callId: 0 }],
    ["callId 1.5", { ...buyBody, callId: 1.5 }],
    ["side 'hold'", { ...buyBody, side: "hold" }],
    ["a 20-char signature", { ...buyBody, signature: "abc".repeat(7) }],
    ["a signature with 0/O/I/l", { ...buyBody, signature: "0OIl".repeat(20) }],
    ["a 101-char signature", { ...buyBody, signature: "1".repeat(101) }],
    ["sizeSol 'NaN'", { ...buyBody, sizeSol: "NaN" }],
    ["sizeSol Infinity", { ...buyBody, sizeSol: "Infinity" }],
    ["qtyRaw 'abc'", { ...buyBody, qtyRaw: "abc" }],
    ["at missing", { ...buyBody, at: undefined }],
  ];
  for (const [label, body] of cases) {
    const r = await post(body);
    ok(`${label} -> 400`, r.status === 400, `HTTP ${r.status}: ${r.json?.error}`);
  }
  const notJson = await post(null, { raw: "{not json" });
  ok("a body that is not JSON -> 400", notJson.status === 400, `HTTP ${notJson.status}: ${notJson.json?.error}`);
  const sellNaN = await post({ callId: call.id, side: "sell", signature: SIG_SELL, at: Date.now(), sol: 0.01, realizedSol: "nope" });
  ok("a sell with a non-finite realizedSol -> 400", sellNaN.status === 400, `HTTP ${sellNaN.status}: ${sellNaN.json?.error}`);
  ok("still nothing written", db.prepare("SELECT COUNT(*) n FROM executor_fills").get().n === 0);
}

console.log("\nA FILL ON A CALL THIS FLOOR WAS NEVER OFFERED IS 404, SO THE BOT KEEPS RETRYING");
{
  const r = await post({ ...buyBody, callId: orphan.id, signature: "5" + "z".repeat(87) });
  ok("no offered delivery -> 404", r.status === 404, `HTTP ${r.status}: ${r.json?.error}`);
  ok("...and it says ok:false, never a false success", r.json?.ok === false, JSON.stringify(r.json));
  ok("...and no row was written", db.prepare("SELECT COUNT(*) n FROM executor_fills").get().n === 0);
  ok("recordExecutorFill itself returns null for it",
    copy.recordExecutorFill(FLOOR, { ...buyBody, callId: orphan.id, signature: "6" + "z".repeat(87) }) === null);
}

console.log("\nA BUY IS STORED WITH ITS REAL NUMBERS AND MARKS THE DELIVERY TAKEN");
{
  const before = db.prepare("SELECT taken, taken_at FROM deliveries WHERE floor_no=? AND call_id=?").get(FLOOR, call.id);
  ok("the delivery is untaken before the report", Number(before.taken) === 0 && before.taken_at == null, JSON.stringify(before));
  const r = await post(buyBody);
  ok("the buy is accepted", r.status === 200 && r.json?.ok === true, `HTTP ${r.status}`);
  const f = r.json?.fill;
  ok("the stored row carries the bot's SOL, not the desk's paper size",
    f?.sol === 0.0175 && f?.lamports_in === 17_500_000, `sol=${f?.sol} lamports_in=${f?.lamports_in}`);
  ok("...the raw quantity as a string", f?.qty_raw === "491380826", `qty_raw=${JSON.stringify(f?.qty_raw)}`);
  ok("...the entry mark and SOL/USD", f?.entry_mark === 0.00102 && f?.sol_usd === 205.5, `${f?.entry_mark} ${f?.sol_usd}`);
  ok("...side, signature, intent", f?.side === "buy" && f?.signature === SIG_BUY && f?.intent_id === "int-1");
  const after = db.prepare("SELECT taken, taken_at FROM deliveries WHERE floor_no=? AND call_id=?").get(FLOOR, call.id);
  ok("the delivery is now taken, with a time", Number(after.taken) === 1 && Number(after.taken_at) > 0, JSON.stringify(after));
  const desk = db.prepare("SELECT size_sol FROM deliveries WHERE floor_no=? AND call_id=?").get(FLOOR, call.id);
  ok("the desk's own paper size is untouched", Number(desk.size_sol) > 0 && Number(desk.size_sol) !== 0.0175, `size_sol=${desk.size_sol}`);
}

console.log("\nA RE-POST BY THE SAME SIGNATURE IS AN UPSERT, NEVER A SECOND FILL");
{
  const again = await post({ ...buyBody, sizeSol: 0.0176, entryMark: null });
  ok("the retry is accepted", again.status === 200, `HTTP ${again.status}`);
  const n = db.prepare("SELECT COUNT(*) n FROM executor_fills WHERE signature=?").get(SIG_BUY).n;
  ok("exactly one row for that signature", n === 1, `${n} rows`);
  const row = db.prepare("SELECT sol, entry_mark FROM executor_fills WHERE signature=?").get(SIG_BUY);
  ok("the mutable figure was refreshed", row.sol === 0.0176, `sol=${row.sol}`);
  ok("a null on the retry does not erase a value the first report carried", row.entry_mark === 0.00102, `entry_mark=${row.entry_mark}`);
  const total = db.prepare("SELECT COUNT(*) n FROM executor_fills").get().n;
  ok("one fill in the table, total", total === 1, `${total}`);
}

console.log("\nEVERY FEED ROW CARRIES THE BOT'S BOOK, AND NEVER THE WALLET");
{
  const row = copy.feedFor(FLOOR, 10).find((r) => r.call_id === call.id);
  ok("bot_status is open after a buy with no sell", row?.bot_status === "open", `bot_status=${row?.bot_status}`);
  ok("bot_size_sol is the bot's SOL", row?.bot_size_sol === 0.0176, `bot_size_sol=${row?.bot_size_sol}`);
  ok("bot_opened_at is the chain time the bot reported", row?.bot_opened_at === buyBody.at, `${row?.bot_opened_at} vs ${buyBody.at}`);
  ok("bot_entry_mark is the mark the bot really paid at", row?.bot_entry_mark === 0.00102, `bot_entry_mark=${row?.bot_entry_mark}`);
  for (const k of ["bot_sold_sol", "bot_realized_sol", "bot_exit_reason", "bot_exit_kind", "bot_exit_code", "bot_closed_at"])
    ok(`${k} is present and null while open`, k in row && row[k] === null, `${k}=${row?.[k]}`);
  ok("the row has no wallet key at all", !("wallet" in row) && !("bot_wallet" in row), Object.keys(row).filter((k) => /wallet/i.test(k)).join(",") || "none");
  ok("the burner address appears nowhere in the whole feed", !JSON.stringify(copy.feedFor(FLOOR, 10)).includes(WALLET));
  const untouched = copy.feedFor(FLOOR, 10).find((r) => r.call_id !== call.id);
  ok("a row with no fills carries bot_status null, not 'closed'", untouched ? untouched.bot_status === null : true, untouched ? `bot_status=${untouched.bot_status}` : "no other row on this floor");
  const src = fs.readFileSync(new URL("./src/copy.js", import.meta.url), "utf8");
  ok("the fill SELECT in feedFor does not name the wallet column",
    /FROM executor_fills WHERE floor_no=\?/.test(src) && !/SELECT[^;]*wallet[^;]*FROM executor_fills WHERE floor_no=\?/.test(src));
}

console.log("\nA SELL FLIPS THE ROW TO CLOSED THE MOMENT IT LANDS — DESK CALL STILL LIVE");
{
  ok("the desk's call is still live", getCall(call.id).status === "live");
  const sellBody = { callId: call.id, side: "sell", signature: SIG_SELL, wallet: WALLET, at: Date.now(),
    qtyRaw: "491380826", sol: 0.0152, realizedSol: -0.0024, fraction: 1, reason: "desk exit: stop_hit",
    kind: "desk_exit", deskCode: "stop_hit", eventId: `${FLOOR}:exit:99`, intentId: "int-2" };
  const r = await post(sellBody);
  ok("the sell is accepted", r.status === 200 && r.json?.fill?.side === "sell", `HTTP ${r.status}`);
  ok("...with realized and reason", r.json?.fill?.realized_sol === -0.0024 && r.json?.fill?.desk_code === "stop_hit",
    `realized=${r.json?.fill?.realized_sol} code=${r.json?.fill?.desk_code}`);
  const row = copy.feedFor(FLOOR, 10).find((x) => x.call_id === call.id);
  ok("bot_status is closed", row?.bot_status === "closed", `bot_status=${row?.bot_status}`);
  ok("...while the desk's status is still live", row?.status === "live", `status=${row?.status}`);
  ok("bot_sold_sol / bot_realized_sol", row?.bot_sold_sol === 0.0152 && row?.bot_realized_sol === -0.0024, `${row?.bot_sold_sol} ${row?.bot_realized_sol}`);
  ok("bot_exit_reason / kind / code", row?.bot_exit_reason === "desk exit: stop_hit" && row?.bot_exit_kind === "desk_exit" && row?.bot_exit_code === "stop_hit",
    `${row?.bot_exit_reason} ${row?.bot_exit_kind} ${row?.bot_exit_code}`);
  ok("bot_closed_at is the chain time of the sell", row?.bot_closed_at === sellBody.at,
    `bot_closed_at=${row?.bot_closed_at} vs ${sellBody.at}`);
  ok("the buy-side facts survive the sell", row?.bot_size_sol === 0.0176 && row?.bot_entry_mark === 0.00102,
    `bot_size_sol=${row?.bot_size_sol} bot_entry_mark=${row?.bot_entry_mark}`);
  ok("the delivery stays taken — a sell is a fact, not an un-take", Number(db.prepare("SELECT taken FROM deliveries WHERE floor_no=? AND call_id=?").get(FLOOR, call.id).taken) === 1);
  ok("no wallet on the row after the sell either", !("wallet" in row) && !JSON.stringify(row).includes(WALLET));
}

/* THE FEED IS UNAUTHENTICATED, SO WHAT RIDES ON IT IS PUBLISHED TO EVERYONE.
 *
 * The wallet column was deliberately withheld from the feed — and then the fill rows'
 * `signature` and `qty_raw` were published beside it as bot_entry_sig, bot_exit_sig and
 * bot_qty_raw. That withheld nothing: a transaction signature pasted into any explorer
 * names the signing wallet in one click, so an anonymous visitor to GET /api/floor/:n/feed
 * could recover the burner's address from the board and read its exact token holding off
 * the same row. The burner is the operator's own, self-hosted, and the whole architecture
 * exists so the server never learns or controls it. The chain identifiers are gone; every
 * bot_* number the board actually draws stays. */
console.log("\nTHE PUBLIC FEED CARRIES NO SIGNATURE, NO QUANTITY AND NO WALLET");
{
  /* Floor 50 is the house's own desk and its feed is public to EVERYONE — floorPrivate
     returns false for the HQ with no session at all — so it is the strictest version of
     this test: an anonymous stranger reading the board the house trades on. Its bot is
     the same self-hosted burner. */
  const HQ = 50;
  const HQ_WALLET = "HqBurner111111111111111111111111111111111111";
  const HQ_SIG_BUY = "8" + "v".repeat(87);
  const HQ_SIG_SELL = "9" + "u".repeat(87);
  const hqCall = publish("HqPub1icFeed1111111111111111111111111111111", "HOUSE");
  copy.broadcast(hqCall.id, [HQ]);
  const hqSecret = copy.settingsFor(HQ).executor_secret;
  const hqBuy = await post({ callId: hqCall.id, side: "buy", signature: HQ_SIG_BUY, wallet: HQ_WALLET,
    at: Date.now() - 45_000, sizeSol: 0.31, lamportsIn: 310_000_000, qtyRaw: "918273645", entryMark: 0.00099,
    solUsd: 205.5 }, { floor: HQ, bearer: hqSecret });
  const hqSell = await post({ callId: hqCall.id, side: "sell", signature: HQ_SIG_SELL, wallet: HQ_WALLET,
    at: Date.now(), sol: 0.27, realizedSol: -0.04, fraction: 1, reason: "desk exit: stop_hit",
    kind: "desk_exit", deskCode: "stop_hit" }, { floor: HQ, bearer: hqSecret });
  ok("the house's bot reported a real buy and a real sell", hqBuy.status === 200 && hqSell.status === 200,
    `buy HTTP ${hqBuy.status}, sell HTTP ${hqSell.status}`);

  const r = await fetch(`${base}/api/floor/${HQ}/feed`);             // no bearer, no session: a stranger
  const payload = await r.json();
  ok("the HQ feed answers a stranger with no credentials at all", r.status === 200 && Array.isArray(payload.feed),
    `HTTP ${r.status}, ${payload.feed?.length} rows`);
  const row = payload.feed.find((x) => x.call_id === hqCall.id);
  ok("the traded call is on it", !!row, row ? `call ${row.call_id} bot_status=${row.bot_status}` : "missing");

  const leaky = Object.keys(row || {}).filter((k) => /sig|signature|qty/i.test(k));
  ok("no key on the public row matches /sig|signature|qty/", leaky.length === 0, `leaky keys: ${leaky.join(",") || "none"}`);
  const allLeaky = [...new Set(payload.feed.flatMap((x) => Object.keys(x)).filter((k) => /sig|signature|qty/i.test(k)))];
  ok("...on any row of the feed", allLeaky.length === 0, `leaky keys across ${payload.feed.length} rows: ${allLeaky.join(",") || "none"}`);

  const body = JSON.stringify(payload);
  ok("the buy signature appears nowhere in the payload", !body.includes(HQ_SIG_BUY),
    `searched ${body.length} bytes for ${HQ_SIG_BUY.slice(0, 10)}…`);
  ok("the sell signature appears nowhere in the payload", !body.includes(HQ_SIG_SELL),
    `searched ${body.length} bytes for ${HQ_SIG_SELL.slice(0, 10)}…`);
  ok("the raw token quantity appears nowhere in the payload", !body.includes("918273645"),
    `searched ${body.length} bytes for 918273645`);
  ok("and the burner wallet is still absent, as it always was", !body.includes(HQ_WALLET),
    `searched ${body.length} bytes for ${HQ_WALLET.slice(0, 10)}…`);
  /* The same holds for the tenant floor's own burner, on the library every route uses. */
  const tenantBody = JSON.stringify(copy.feedFor(FLOOR, 40));
  ok("floor 7's own signatures are absent from feedFor too",
    !tenantBody.includes(SIG_BUY) && !tenantBody.includes(SIG_SELL) && !tenantBody.includes("491380826"),
    `searched ${tenantBody.length} bytes for ${SIG_BUY.slice(0, 8)}…/${SIG_SELL.slice(0, 8)}…/491380826`);

  /* The row is stripped, not broken: the board reads these ten and would go blank
     without them. Two of them are null here only because the sell already landed. */
  const kept = ["bot_status", "bot_size_sol", "bot_opened_at", "bot_entry_mark", "bot_sold_sol",
    "bot_realized_sol", "bot_exit_reason", "bot_exit_kind", "bot_exit_code", "bot_closed_at"];
  const missing = kept.filter((k) => !(k in (row || {})));
  ok("every bot_* field the board draws is still there", missing.length === 0, `missing: ${missing.join(",") || "none"}`);
  ok("...and still carries the bot's real numbers, not the desk's paper",
    row?.bot_status === "closed" && row?.bot_size_sol === 0.31 && row?.bot_realized_sol === -0.04,
    `bot_status=${row?.bot_status} bot_size_sol=${row?.bot_size_sol} bot_realized_sol=${row?.bot_realized_sol}`);

  /* And the desk still HOLDS the signature — it is stored and simply never published.
     The fix is the SELECT, not a lost fact: the desk can still prove the fill on chain. */
  const stored = db.prepare("SELECT signature, qty_raw, wallet FROM executor_fills WHERE floor_no=? AND call_id=? AND side='buy'")
    .get(HQ, hqCall.id);
  ok("the desk still has the signature, the quantity and the wallet in its own table",
    stored?.signature === HQ_SIG_BUY && stored?.qty_raw === "918273645" && stored?.wallet === HQ_WALLET,
    `stored sig=${String(stored?.signature).slice(0, 8)}… qty=${stored?.qty_raw} wallet=${String(stored?.wallet).slice(0, 8)}…`);

  const copySrc = fs.readFileSync(new URL("./src/copy.js", import.meta.url), "utf8");
  const sel = copySrc.match(/SELECT[^;]*?FROM executor_fills WHERE floor_no=\?/s)?.[0] ?? "";
  ok("feedFor's fill SELECT names neither signature nor qty_raw nor wallet",
    sel.length > 0 && !/\bsignature\b|\bqty_raw\b|\bwallet\b/.test(sel), sel.replace(/\s+/g, " ").trim());
}

/* ONE FLOOR'S FILL REPORT MUST NOT READ ANOTHER FLOOR'S ROW.
 *
 * executor_fills.signature is globally UNIQUE. INSERT OR IGNORE therefore does nothing
 * when a signature is already claimed — and the read-back that followed it was
 * "SELECT * FROM executor_fills WHERE signature=?", unscoped, so the floor that just
 * failed to write received the OWNER's entire row over an authenticated 200: floor,
 * call, side, numbers, and the wallet column that is withheld everywhere else. One
 * copied signature was a cross-floor read of somebody's burner address. The read-back
 * now carries the caller's own identity and a claimed signature is a 409 — the write
 * really did not happen, and a 200 saying otherwise would end the bot's retry the way
 * the take route already taught us not to. */
console.log("\nA SIGNATURE ANOTHER FLOOR ALREADY CLAIMED IS 409, NOT SOMEBODY ELSE'S ROW");
{
  const OTHER = 8;
  const OTHER_WALLET = "0therBurner11111111111111111111111111111111";
  const SIG_OTHER = "7" + "w".repeat(87);
  db.prepare("UPDATE floors SET state='owned', owner=?, name=?, claimed_at=? WHERE n=?")
    .run("0therWa11et1111111111111111111111111111111111", "Eighth Floor Partners", Date.now(), OTHER);
  const theirCall = publish("The1rCa1111111111111111111111111111111111111", "THEIRS");
  const theirOther = publish("The1rSecond11111111111111111111111111111111", "THEIRS2");
  copy.broadcast(theirCall.id, [OTHER]);
  copy.broadcast(theirOther.id, [OTHER]);
  const clash = publish("C1ashCa1111111111111111111111111111111111111", "CLASH");   // floor 7's, untaken
  copy.broadcast(clash.id, [FLOOR]);
  const otherSecret = copy.settingsFor(OTHER).executor_secret;
  ok("the two floors have different secrets", Boolean(otherSecret) && otherSecret !== secret,
    `${String(secret).slice(0, 6)}… vs ${String(otherSecret).slice(0, 6)}…`);

  const theirBuy = { callId: theirCall.id, side: "buy", signature: SIG_OTHER, wallet: OTHER_WALLET,
    at: Date.now() - 30_000, sizeSol: 0.05, lamportsIn: 50_000_000, qtyRaw: "777", entryMark: 0.002, solUsd: 205.5 };
  const mine = await post(theirBuy, { floor: OTHER, bearer: otherSecret });
  ok("floor 8 stores its own buy", mine.status === 200 && mine.json?.fill?.floor_no === OTHER,
    `HTTP ${mine.status}, floor_no=${mine.json?.fill?.floor_no}`);
  ok("...and the stored row really does carry floor 8's wallet — this is what leaked",
    db.prepare("SELECT wallet FROM executor_fills WHERE signature=?").get(SIG_OTHER)?.wallet === OTHER_WALLET,
    `wallet=${db.prepare("SELECT wallet FROM executor_fills WHERE signature=?").get(SIG_OTHER)?.wallet}`);

  const stolen = await post({ ...buyBody, callId: clash.id, signature: SIG_OTHER, wallet: null });
  ok("floor 7 reporting floor 8's signature is 409, not 200", stolen.status === 409,
    `HTTP ${stolen.status}: ${stolen.json?.error}`);
  ok("...and says ok:false, so the bot's queue is not told a lie", stolen.json?.ok === false, JSON.stringify(stolen.json));
  ok("...and hands back no fill row at all", !("fill" in (stolen.json || {})), JSON.stringify(Object.keys(stolen.json || {})));
  const stolenBody = JSON.stringify(stolen.json);
  ok("...and floor 8's wallet is nowhere in the 409 body", !stolenBody.includes(OTHER_WALLET), stolenBody);
  ok("...nor floor 8's call id", !stolenBody.includes(String(theirCall.id)), stolenBody);

  const owner = db.prepare("SELECT floor_no, call_id, side, wallet FROM executor_fills WHERE signature=?").get(SIG_OTHER);
  ok("the row still belongs to floor 8, unrebound", owner.floor_no === OTHER && owner.call_id === theirCall.id && owner.wallet === OTHER_WALLET,
    JSON.stringify(owner));
  const n = db.prepare("SELECT COUNT(*) n FROM executor_fills WHERE signature=?").get(SIG_OTHER).n;
  ok("still exactly one row for that signature", n === 1, `${n} rows`);
  const taken = db.prepare("SELECT taken FROM deliveries WHERE floor_no=? AND call_id=?").get(FLOOR, clash.id);
  ok("the refused report did NOT mark floor 7's delivery taken", Number(taken.taken) === 0, `taken=${taken.taken}`);

  /* The scope is all four identity columns, not just the floor. */
  const wrongCall = await post({ ...theirBuy, callId: theirOther.id }, { floor: OTHER, bearer: otherSecret });
  ok("floor 8 re-using its own signature on a DIFFERENT call is 409 too", wrongCall.status === 409,
    `HTTP ${wrongCall.status}: ${wrongCall.json?.error}`);
  const wrongSide = await post({ callId: theirCall.id, side: "sell", signature: SIG_OTHER, at: Date.now(),
    sol: 0.04, realizedSol: -0.01, fraction: 1 }, { floor: OTHER, bearer: otherSecret });
  ok("...and on a different SIDE is 409", wrongSide.status === 409, `HTTP ${wrongSide.status}: ${wrongSide.json?.error}`);
  const honest = await post({ ...theirBuy, sizeSol: 0.051 }, { floor: OTHER, bearer: otherSecret });
  ok("the honest retry — same floor, call, side and signature — is still 200 with its own row",
    honest.status === 200 && honest.json?.fill?.signature === SIG_OTHER && honest.json?.fill?.sol === 0.051,
    `HTTP ${honest.status}, sol=${honest.json?.fill?.sol}`);
  const after = db.prepare("SELECT COUNT(*) n FROM executor_fills WHERE signature=?").get(SIG_OTHER).n;
  ok("...and it is still one row, an upsert not a second fill", after === 1, `${after} rows`);

  ok("recordExecutorFill itself answers a conflict, never a row",
    copy.recordExecutorFill(FLOOR, { ...buyBody, callId: clash.id, signature: SIG_OTHER })?.conflict === "signature_claimed",
    JSON.stringify(copy.recordExecutorFill(FLOOR, { ...buyBody, callId: clash.id, signature: SIG_OTHER })));

  const copySrc = fs.readFileSync(new URL("./src/copy.js", import.meta.url), "utf8");
  ok("the read-back is scoped to signature AND floor AND call AND side",
    /SELECT \* FROM executor_fills WHERE signature=\? AND floor_no=\? AND call_id=\? AND side=\?/.test(copySrc),
    (copySrc.match(/SELECT \* FROM executor_fills WHERE [^"]*/) || ["none"])[0]);
  ok("...and no unscoped read-back survives anywhere in copy.js",
    !/SELECT \* FROM executor_fills WHERE signature=\?"/.test(copySrc));
  const officeSrc = fs.readFileSync(new URL("./src/office.js", import.meta.url), "utf8");
  ok("the route maps a conflict to 409", /if \(fill\.conflict\) return json\(409/.test(officeSrc));
}

console.log("\nTHE FEED EVENTS CARRY THE DESK'S OWN CLOCK");
{
  await alerts.announceEntry(call);
  closeCall(call.id, "stop_hit", 0.00074);
  await alerts.announceExit(call, { code: "stop_hit", urgency: "level", detail: "stop hit" });
  const feed = executorFeedPayload(FLOOR, 0);
  const entry = feed.events.find((e) => e.call_id === call.id && e.type === "entry");
  const exit = feed.events.find((e) => e.call_id === call.id && e.type === "exit");
  ok("the entry event is gone once the call closed (never buy a closed call)", !entry);
  ok("the exit event exists", !!exit, exit ? `id=${exit.id}` : "none");
  ok("the exit event carries close_mark", exit?.close_mark === 0.00074, `close_mark=${exit?.close_mark}`);
  ok("...and closed_at from the calls row", exit?.closed_at === getCall(call.id).closed_at, `closed_at=${exit?.closed_at}`);
  ok("...and opened_at", exit?.opened_at === getCall(call.id).opened_at, `opened_at=${exit?.opened_at}`);
}

console.log("\nA CLOSED CALL WITH NO EXIT ALERT IS REPAIRED — IDEMPOTENTLY");
{
  const repaired = [];
  const onEvent = (ev) => { if (ev?.type === "alert:repaired") repaired.push(ev); };
  bus.on("event", onEvent);

  const lost = publish("LostExit111111111111111111111111111111111111", "LOST");
  copy.broadcast(lost.id, [FLOOR]);
  closeCall(lost.id, "stop_hit", 0.0007);          // fireExit's announceExit never landed
  const beforeN = db.prepare("SELECT COUNT(*) n FROM alerts WHERE floor_no=? AND call_id=? AND kind='exit'").get(FLOOR, lost.id).n;
  ok("no exit alert exists after the lost announce", beforeN === 0, `${beforeN}`);
  const n1 = alerts.reconcileMissingExitAlerts(FLOOR);
  ok("one exit alert is repaired", n1 === 1, `repaired=${n1}`);
  const a = db.prepare("SELECT * FROM alerts WHERE floor_no=? AND call_id=? AND kind='exit'").get(FLOOR, lost.id);
  ok("the repaired alert reads like a live stop_hit: 'Exit called', urgency normal",
    a?.title === "Exit called — LOST" && a?.urgency === "normal", `${a?.title} / ${a?.urgency}`);
  ok("...and names the code and the print", /stop hit at \$0\.0007/.test(a?.body || ""), (a?.body || "").slice(0, 80));
  ok("alert:repaired was emitted with kind 'exit'",
    repaired.some((e) => e.callId === lost.id && e.kind === "exit"), JSON.stringify(repaired.map((e) => [e.callId, e.kind])));
  const n2 = alerts.reconcileMissingExitAlerts(FLOOR);
  ok("a second sweep repairs nothing", n2 === 0, `repaired=${n2}`);
  const count = db.prepare("SELECT COUNT(*) n FROM alerts WHERE floor_no=? AND call_id=? AND kind='exit'").get(FLOOR, lost.id).n;
  ok("still exactly one exit alert", count === 1, `${count}`);
  ok("the exit now rides the executor feed", executorFeedPayload(FLOOR, 0).events.some((e) => e.call_id === lost.id && e.type === "exit"));

  const rug = publish("RugExit1111111111111111111111111111111111111", "RUG");
  copy.broadcast(rug.id, [FLOOR]);
  closeCall(rug.id, "liq_collapse", 0.0002);
  alerts.reconcileMissingExitAlerts(FLOOR);
  const ra = db.prepare("SELECT * FROM alerts WHERE floor_no=? AND call_id=? AND kind='exit'").get(FLOOR, rug.id);
  ok("a chain-fact close is repaired as EXIT NOW / urgent, as the live one would have been",
    ra?.title === "EXIT NOW — RUG" && ra?.urgency === "urgent", `${ra?.title} / ${ra?.urgency}`);

  const old = publish("O1dExit11111111111111111111111111111111111111", "OLD");
  copy.broadcast(old.id, [FLOOR]);
  closeCall(old.id, "stop_hit", 0.0007);
  db.prepare("UPDATE calls SET closed_at=? WHERE id=?").run(Date.now() - 7 * 3600e3, old.id);
  const n3 = alerts.reconcileMissingExitAlerts(FLOOR);
  ok("a call closed 7h ago is outside the 6h window and left alone", n3 === 0, `repaired=${n3}`);
  const n4 = alerts.reconcileMissingExitAlerts(FLOOR, { withinMs: 8 * 3600e3 });
  ok("...but a wider window reaches it", n4 === 1, `repaired=${n4}`);

  const liveOne = publish("Sti11Live11111111111111111111111111111111111", "LIVE");
  copy.broadcast(liveOne.id, [FLOOR]);
  const n5 = alerts.reconcileMissingExitAlerts(FLOOR);
  ok("a live call is never given an exit alert", n5 === 0 &&
    db.prepare("SELECT COUNT(*) n FROM alerts WHERE call_id=? AND kind='exit'").get(liveOne.id).n === 0, `repaired=${n5}`);
  const skipped = publish("SkippedCa11111111111111111111111111111111111", "SKIP");
  db.prepare("INSERT INTO deliveries (call_id,floor_no,verdict,reason,size_sol,delivered_at) VALUES (?,?,?,?,?,?)")
    .run(skipped.id, FLOOR, "skipped", "test", null, Date.now());
  closeCall(skipped.id, "stop_hit", 0.0007);
  const n6 = alerts.reconcileMissingExitAlerts(FLOOR);
  ok("a floor that was only ever SKIPPED the call gets no exit alert", n6 === 0, `repaired=${n6}`);

  bus.off("event", onEvent);
}

console.log("\nTHE BOT'S OWN POLL RUNS THE REPAIR");
{
  const viaPoll = publish("Po11Repair1111111111111111111111111111111111", "POLL");
  copy.broadcast(viaPoll.id, [FLOOR]);
  closeCall(viaPoll.id, "target_hit", 0.0021);
  const r = await fetch(`${base}/api/floor/${FLOOR}/executor/feed?after=0`, { headers: { authorization: `Bearer ${secret}` } });
  const feed = await r.json();
  const ev = (feed.events || []).find((e) => e.call_id === viaPoll.id && e.type === "exit");
  ok("GET /executor/feed repaired and served the exit in one poll", r.status === 200 && !!ev,
    `HTTP ${r.status}, exit ${ev ? `id=${ev.id} code=${ev.code} close_mark=${ev.close_mark}` : "missing"}`);
  ok("...with close_mark and closed_at on the wire", ev?.close_mark === 0.0021 && Number(ev?.closed_at) > 0,
    `${ev?.close_mark} ${ev?.closed_at}`);
}

server.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
