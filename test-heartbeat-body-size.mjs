/**
 * THE BODY READER THAT TOOK A LIVE BOT OFFLINE FOR NINE HOURS.
 *
 * 2026-09-17. The owner's WALL-ST-E traded all day — signatures landing on mainnet
 * minute after minute — while the floor showed his desk frozen at 08:23:51Z. His log
 * said the same sentence 146 times:
 *
 *   heartbeat to the desk failed (HTTP 502) — 146 miss(es), no pulse has been
 *   acknowledged since boot; the floor board shows this bot OFFLINE until a pulse
 *   lands. Trading is unaffected.
 *
 * The cause was here, in eight characters of this server. `readBody()` capped at 8192
 * bytes and, past that, called `req.destroy()` and then waited for `end` — an event
 * that NEVER FIRES on a destroyed request. The promise never settled, the route never
 * answered, the socket died, and the proxy in front of the process turned that into a
 * 502 the client could do nothing with. Meanwhile the executor heartbeat had grown
 * past 8 KiB: it carries up to 20 closes, a ledger, health, reporting and — since the
 * launch lane got a book — up to 200 snipe exits.
 *
 * So the defect was never "the body is too big". It was that TOO BIG WAS INDISTIN-
 * GUISHABLE FROM THE SERVER DYING, and the honest 413-shaped answer was replaced by a
 * hung connection. This file pins both halves against the real server on a real
 * socket, because neither is visible in a unit test of a pure function:
 *
 *   · a heartbeat the size the bot actually sends is ACCEPTED and stored;
 *   · a body past the limit still gets an ANSWER, promptly, rather than a dead socket;
 *   · the reader cannot hang on any ending a client can produce.
 *
 *   node test-heartbeat-body-size.mjs
 */
if (!process.env.CLAUDE_CO_DB) throw new Error("test runner must provide CLAUDE_CO_DB");
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "hb-body-"));
process.env.CLAUDE_CO_DB = path.join(TMP, "office.db");
process.env.NODE_NO_WARNINGS = "1";

const { encode } = await import("./src/lib/base58.js");
function keypair() {
  const { publicKey } = crypto.generateKeyPairSync("ed25519");
  return { wallet: encode(publicKey.export({ format: "der", type: "spki" }).subarray(-32)) };
}
const tenant = keypair(), boss = keypair();
process.env.HQ_OWNER_WALLET = boss.wallet;

const db = (await import("./src/lib/store.js")).default;
await import("./src/tower.js");
const copy = await import("./src/copy.js");
const { startOffice } = await import("./src/office.js");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
};

const FLOOR = 41;
const SECRET = "heartbeat-body-size-secret-0123456789abcd";
db.prepare("INSERT INTO leases (floor_no, wallet, base_units, name, created_at) VALUES (?,?,?,?,?)")
  .run(FLOOR, tenant.wallet, "0", "Forty-First Floor", Date.now());
db.prepare("UPDATE floors SET state='owned', owner=?, name=?, claimed_at=? WHERE n=?")
  .run(tenant.wallet, "Forty-First Floor", Date.now(), FLOOR);
copy.settingsFor(FLOOR);
db.prepare("UPDATE copy_settings SET executor_secret=? WHERE floor_no=?").run(SECRET, FLOOR);

const { server: office } = startOffice(0);
await once(office, "listening");
const BASE = `http://127.0.0.1:${office.address().port}`;

/** POST a heartbeat with a hard deadline: a hang is the defect, so it must be a FAILURE
 *  here and not a test that waits for ever and gets killed by the runner. */
async function postHeartbeat(body, { ms = 10_000 } = {}) {
  const started = Date.now();
  try {
    const r = await fetch(`${BASE}/api/floor/${FLOOR}/executor/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: typeof body === "string" ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(ms),
    });
    return { status: r.status, ms: Date.now() - started, hung: false };
  } catch (error) {
    return { status: null, ms: Date.now() - started, hung: true, error: String(error?.name || error) };
  }
}

/* The shape the bot actually posts, at the size it actually posts it. `closed` is
   capped at 20 by the poller and the snipe book at 200, so this is not a worst case —
   it is an ordinary day for a launch lane that has been running. */
/* Real base58, because the desk's sanitizer checks it and silently drops a row that is
   not — which is how the first draft of this file "proved" a book that had been thrown
   away. No 0, O, I or l. */
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const mint = (i) => {
  let s = "";
  for (let n = 0; n < 44; n++) s += B58[(i * 7 + n * 13 + 5) % B58.length];
  return s;
};
const realHeartbeat = () => ({
  mode: "live", wallet: tenant.wallet, cursor: 12345, open: 3,
  held: Array.from({ length: 4 }, (_, i) => ({ mint: mint(i), symbol: `TK${i}`, qtyRaw: "123456789" })),
  closed: Array.from({ length: 20 }, (_, i) => ({
    mint: mint(100 + i), symbol: `SYM${i}`, callId: i, closedAt: Date.now() - i * 1000,
    openedAt: Date.now() - i * 2000, solIn: 0.5, solOut: 0.43, realizedSol: -0.07, fraction: 1,
    reason: "desk exit (thesis_expired) — the desk's own clock ran out on this call",
    kind: "desk_exit", reported: true,
  })),
  ledger: { realizedSol: -1.64, deployedSol: 22.4, feesSol: 0.31, deployments: 64, exits: 64 },
  snipe: {
    mode: "execute", state: "up", counts: { notices: 4021, refused: 3900, entered: 64, exited: 64 },
    open: [],
    book: {
      trades: 200, counted: 200, wins: 35, losses: 165, unknown: 2, realizedSol: -1.6486,
      closed: Array.from({ length: 200 }, (_, i) => ({
        mint: mint(1000 + i), closedAt: Date.now() - i * 60_000,
        reason: "stall exit at 90s — it never got above entry, and a launch that has not moved by now will not",
        realizedSol: -0.0185, sizeSol: 0.1,
      })),
    },
  },
  ts: Date.now(),
});

console.log("\nthe heartbeat the bot actually sends");
const real = realHeartbeat();
const realBytes = JSON.stringify(real).length;
ok("the real payload is well past the 8192 bytes this server used to allow",
  realBytes > 8192, `${realBytes} bytes`);
const accepted = await postHeartbeat(real);
ok("...and the desk accepts it", accepted.status === 200,
  accepted.hung ? `HUNG (${accepted.error}) after ${accepted.ms}ms` : `HTTP ${accepted.status}`);
ok("...promptly, not after a timeout", !accepted.hung && accepted.ms < 5000, `${accepted.ms}ms`);
const stored = db.prepare("SELECT executor_heartbeat FROM copy_settings WHERE floor_no=?").get(FLOOR);
ok("...and it is stored, which is the whole point of sending it",
  !!stored?.executor_heartbeat && JSON.parse(stored.executor_heartbeat).mode === "live");
ok("...with the launch lane's book on it, the block that pushed it over 8 KiB",
  (JSON.parse(stored.executor_heartbeat).snipe?.book?.closed || []).length > 0);

console.log("\na body past the limit is answered, never left hanging");
/* THE REGRESSION. Before the fix this destroyed the socket and resolved nothing: the
   client saw a dead connection and a proxy in front of it published 502. What it must
   do is DECIDE — any status at all is a fix; silence is the bug. */
const huge = "x".repeat(2 * 1024 * 1024);
const over = await postHeartbeat(`{"mode":"live","pad":"${huge}"}`);
ok("an over-size body still gets a status line", !over.hung,
  over.hung ? `HUNG (${over.error}) after ${over.ms}ms` : `HTTP ${over.status}`);
ok("...and it is a refusal, not a silent success", over.status !== 200, `HTTP ${over.status}`);
ok("...answered promptly rather than at a proxy's timeout", over.ms < 5000, `${over.ms}ms`);

console.log("\nno ending a client can produce leaves the reader unsettled");
const malformed = await postHeartbeat("{not json at all");
ok("a malformed body is refused rather than hung",
  !malformed.hung && malformed.status === 400, `HTTP ${malformed.status} in ${malformed.ms}ms`);
/* An empty body parses as {} and is accepted — pre-existing behaviour, stated rather
   than asserted away, and not this fix's business. What IS this fix's business is that
   it answers at all. */
const empty = await postHeartbeat("");
ok("an empty body is answered rather than hung", !empty.hung && empty.ms < 5000,
  `HTTP ${empty.status} in ${empty.ms}ms`);

/* A CUT-OFF REQUEST. The client promises a length and then goes away — the exact shape
   that used to leave a promise nobody would ever resolve. The socket ends up closed
   either way; what matters is that this process moves on rather than accumulating a
   pending route per abandoned connection. */
const cut = await (async () => {
  const net = await import("node:net");
  const { port } = office.address();
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(`POST /api/floor/${FLOOR}/executor/heartbeat HTTP/1.1\r\nHost: x\r\n` +
        `authorization: Bearer ${SECRET}\r\ncontent-type: application/json\r\n` +
        "content-length: 9999\r\n\r\n{\"mode\":");
      setTimeout(() => { sock.destroy(); resolve(true); }, 250);
    });
    sock.on("error", () => resolve(true));
  });
})();
ok("a client that announces a length and vanishes does not wedge the server", cut === true);
const afterCut = await postHeartbeat(realHeartbeat());
ok("...and the very next heartbeat is still served", afterCut.status === 200,
  afterCut.hung ? `HUNG after ${afterCut.ms}ms` : `HTTP ${afterCut.status}`);

console.log("\nthe reader's own shape");
{
  const source = fs.readFileSync(path.join(ROOT, "src", "office.js"), "utf8");
  const reader = source.slice(source.indexOf("const MAX_BODY_BYTES"),
    source.indexOf("const MAX_BODY_BYTES") + 1400);
  ok("it never destroys the request out from under its own promise",
    !/req\.destroy\(\)/.test(reader));
  ok("it settles exactly once, however many endings arrive",
    /let settled = false;/.test(reader) && /if \(!settled\)/.test(reader));
  ok("every ending settles it, not just a clean end",
    /for \(const dead of \["error", "aborted", "close"\]\)/.test(reader));
  const cap = Number(source.match(/const MAX_BODY_BYTES = (\d+) \* 1024;/)?.[1]);
  ok("the limit is sized for the payloads this API receives", cap >= 64,
    `${cap} KiB, against a ${(realBytes / 1024).toFixed(1)} KiB heartbeat`);
}

office.close();
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} test-heartbeat-body-size  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
