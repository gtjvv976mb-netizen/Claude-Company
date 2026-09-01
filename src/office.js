import http from "node:http";
/* Floor 50 — the penthouse — belongs to the HOUSE: the treasury wallet always,
   plus every wallet named in HQ_OWNER (comma-separated — the dev wallet lives
   here), plus whatever wallet is written on the floor's own deed. */
/* RETIRED. HQ ownership is the deed on floor 50 and nothing else — see
   tower.hqOwnerWallet(). Kept only so an old HQ_OWNER env var cannot silently
   grant standing it no longer carries. */
const HQ_OWNER_LIST_RETIRED = [
  ...(process.env.HQ_OWNER || "").split(",").map((w) => w.trim()).filter(Boolean),
  "3J57tqAJqRmSBn1ZYDu9JpMMyTfBHdcGGwECiPQeiji3",   // the dev wallet — standing owner (owner-stated)
];
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";
import { bus, backlog, emit, runFor, chronicleRead } from "./lib/bus.js";
import { census as funnelCensus } from "./funnel.js";
import { spend, spendSince } from "./lib/llm.js";
import { cfg } from "./config.js";
import * as store from "./lib/store.js";
import db from "./lib/store.js";
import crypto from "node:crypto";
function cryptoTimingEqual(a, b) {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
import * as tower from "./tower.js";
import * as auth from "./auth.js";
import * as leasing from "./leasing.js";
import * as rooms from "./rooms.js";
import * as calls from "./calls.js";
import * as mandate from "./mandate.js";
import "./devrep.js";
import * as shadowBook from "./shadow.js";   // creates dev_reputation; the overview counts it
import * as copy from "./copy.js";
import * as perf from "./perf.js";
import * as alerts from "./alerts.js";
import * as identity from "./identity.js";
import * as passes from "./passes.js";
import { callouts } from "./whales.js";
import { retiredBrowserRpcResponse } from "./execution-gates.js";
import { providerCreditHealth } from "./provider-health.js";
import { currentImprovementBundle, improvementServiceStatus } from "./improvement-bundle.js";
import {
  eventVisibleOnFloor,
  mayReadEventStream,
  requestedEventFloor,
} from "./event-stream-policy.js";

/** When THIS process started. A short uptime next to a stale event is a restart. */
const BOOTED_AT = Date.now();

/** Build the authenticated poller's response after the route has checked its secret. */
export function executorFeedPayload(floorNo, rawAfter = 0) {
  // A malformed cursor must not bind as NaN — SQLite compares everything to NULL as
  // false, so the bot would poll a permanently empty feed at HTTP 200 and never trade.
  const parsedAfter = Number(rawAfter);
  const after = Number.isFinite(parsedAfter) && parsedAfter >= 0 ? Math.floor(parsedAfter) : 0;
  const rows = db.prepare(`
    SELECT a.id, a.call_id, a.kind, a.mint, a.urgency, a.created_at,
           c.symbol, c.category, c.launchpad, c.conviction,
           c.entry_ref, c.entry_lo, c.entry_hi, c.stop, c.target, c.close_reason, c.status, c.opened_at,
           c.liq_at_call, c.rt_loss_at_call, c.policy_version,
           COALESCE((SELECT e.mark FROM call_events e
                     WHERE e.call_id=c.id AND e.mark IS NOT NULL
                     ORDER BY e.id DESC LIMIT 1), c.entry_ref) AS current_mark,
           COALESCE((SELECT MAX(e.ts) FROM call_events e
                     WHERE e.call_id=c.id AND e.mark IS NOT NULL), c.opened_at) AS current_mark_at,
           (SELECT size_sol FROM deliveries d WHERE d.call_id=a.call_id AND d.floor_no=a.floor_no) AS size_sol
    FROM alerts a LEFT JOIN calls c ON c.id=a.call_id
    WHERE a.floor_no=? AND a.id > ? AND a.kind IN ('entry','exit')
      -- Never hand a bot an ENTRY for a call that has already closed. After any
      -- downtime the backlog would otherwise become instructions to market-buy
      -- coins the desk has already exited.
      AND NOT (a.kind = 'entry' AND c.status = 'closed')
    ORDER BY a.id LIMIT 50`).all(floorNo, after);
  const latestId = db.prepare(`SELECT MAX(a.id) id FROM alerts a
    LEFT JOIN calls c ON c.id=a.call_id
    WHERE a.floor_no=? AND a.kind IN ('entry','exit')
      AND NOT (a.kind='entry' AND c.status='closed')`).get(floorNo)?.id ?? after;
  /* THE FLOOR'S OWN RULES RIDE WITH THE CALL.
   * The bot must not have to be reconfigured when a tenant changes their mind
   * in the UI: the take-profit multiple travels on every event, so a floor
   * switching from "sell at 2x" to "ride to 10x" takes effect on the next
   * poll rather than on the next redeploy of somebody's VPS. 0 means auto —
   * the bot then honours the desk's own authored target. */
  const floorSettings = copy.settingsFor(floorNo);
  return { cluster: "mainnet-beta", latest_id: latestId,
    next_cursor: rows.length ? rows[rows.length - 1].id : after,
    rules: { take_profit_x: floorSettings.take_profit_x ?? 0,
             fixed_sol: floorSettings.fixed_sol ?? 0,
             mcap_tier: floorSettings.mcap_tier ?? "any" },
    events: rows.map((r) => ({
      id: r.id, event_id: `${floorNo}:${r.kind}:${r.id}`, call_id: r.call_id,
      type: r.kind, mint: r.mint, symbol: r.symbol,
      side: r.kind === "entry" ? "buy" : "sell",
      size_sol: r.size_sol ?? null, entry_ref: r.entry_ref,
      entry_lo: r.entry_lo, entry_hi: r.entry_hi, stop: r.stop, target: r.target,
      current_mark: r.current_mark, current_mark_at: r.current_mark_at,
      conviction: r.conviction, category: r.category, launchpad: r.launchpad,
      liq_at_call: r.liq_at_call, rt_loss_at_call: r.rt_loss_at_call,
      policy_version: r.policy_version,
      take_profit_x: floorSettings.take_profit_x ?? 0,
      fixed_sol: floorSettings.fixed_sol ?? 0,
      code: r.close_reason ?? null, urgency: r.urgency, ts: r.created_at,
    })) };
}

/** Serves the trading floor and streams the desk's real events to it. */
export function startOffice(port = Number(process.env.PORT) || 4949) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    // The site and the API are on different origins by design (static host + Render), so
    // every response needs these — not just the /api/ ones. /events did not have them,
    // which silently dropped every floor back to the demo feed.
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type,authorization,solana-client");
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    if (url.pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      // ?floor=N gives a tenant only their own desk's work. No argument means HQ,
      // never the internal all-floors backlog: a tenant must not turn a missing query
      // parameter into a subscription to every other tenant's private stream.
      const wantFloor = requestedEventFloor(url);
      // EventSource cannot send headers, so the tenant's token rides the query
      // string (same-origin HTTPS). A visitor to a leased floor is told plainly
      // and the stream ends — the client runs its demo shift instead.
      {
        const sid = url.searchParams.get("sid");
        const who = sid ? auth.walletFor(sid) : null;
        const lease = wantFloor != null && wantFloor !== 50
          ? leasing.leaseFor(wantFloor) : null;
        const allowed = mayReadEventStream({
          floor: wantFloor,
          wallet: who,
          hqOwner: tower.hqOwnerWallet(),
          leaseWallet: lease?.wallet,
          hasPass: Boolean(lease && who && passes.passFor(wantFloor, who)),
        });
        if (!allowed) {
          const exists = wantFloor === 50 || Boolean(lease);
          res.write(`event: hello\ndata: ${JSON.stringify({ private: true, hq: wantFloor === 50, vacant: !exists, floor: wantFloor })}\n\n`);
          res.end();
          return;
        }
      }
      res.write(`event: hello\ndata: ${JSON.stringify({ backlog: backlog(wantFloor), floor: wantFloor })}\n\n`);
      // A room shows two things at once: the HOUSE desk working (floor null, the same
      // for every visitor) and that floor's own activity. Filtering strictly to the floor
      // hid the house team entirely, so every room looked idle while the desk was busy.
      const onEvent = (ev) => {
        if (!eventVisibleOnFloor(wantFloor, ev)) return;
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      };
      bus.on("event", onEvent);
      const ping = setInterval(() => res.write(": ping\n\n"), 15000);
      req.on("close", () => { bus.off("event", onEvent); clearInterval(ping); });
      return;
    }

    if (url.pathname === "/favicon.ico" || url.pathname === "/favicon.svg") {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
        `<rect width="32" height="32" rx="6" fill="#30454a"/>` +
        `<rect x="10" y="7" width="12" height="19" fill="#f0e4c7"/>` +
        `<rect x="9" y="5" width="14" height="3" fill="#e0ad3d"/>` +
        `<circle cx="16" cy="3" r="2.4" fill="#d97757"/></svg>`;
      res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8" });
      res.end(svg);
      return;
    }

    // Token art, served for local dev; the static build copies these into dist/assets.
    if (url.pathname.startsWith("/assets/")) {
      const name = path.basename(url.pathname);
      const af = path.join(ROOT, "token", name);
      if (/^[\w-]+\.png$/.test(name) && fs.existsSync(af)) {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(fs.readFileSync(af));
        return;
      }
      res.writeHead(404); res.end("no such asset"); return;
    }

    // ── leasing API ─────────────────────────────────────────────────────────
    if (url.pathname.startsWith("/api/")) {
      const json = (code, body) => {
        res.writeHead(code, { "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store", "access-control-allow-origin": "*",
          "access-control-allow-headers": "content-type,authorization,solana-client" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "OPTIONS") { json(204, {}); return; }

      const bearer = (req.headers.authorization || "").replace(/^Bearer /, "") || null;
      const me = auth.walletFor(bearer);

      /* Floors 1-49 are leased offices: their live data belongs to the tenant.
       * The 50th floor is the house desk and stays public — it is the showroom.
       * Enforced here, because a client that merely chooses not to look is not
       * privacy. */
      const HQ_FLOOR = 50;
      // The HQ's owner is the treasury's owner (floors.owner as a future override).
      // Identity and money are different jobs: TREASURY_OWNER is where lease
      // payments land; HQ_OWNER is the wallet the boss signs in with. They are
      // often the same wallet — the day they are not, the boss was locked out of
      // their own building and saw the demo like a tourist.
      /* SOLE OWNERSHIP. This was a set — treasury OR an env list OR the deed —
       * which handed the house desk's settings and its executor secret to several
       * wallets at once. It is now the deed alone, asserted on every boot. */
      const hqOwner = (w) => tower.isHqOwner(w);
      /* Does THIS wallet hold THIS floor? A lease for a leased floor; ownership
         of the house for floor 50, which carries no lease row by design. This
         was written longhand on six routes and three forgot the penthouse — so
         on the house floor "Got it" on an alert answered 403 and the yellow bar
         would not go away. One helper now; a new route cannot forget. */
      const holdsFloor = (floorNo) => {
        if (!me) return false;
        if (floorNo === tower.HQ_FLOOR && hqOwner(me)) return true;
        const l = leasing.leaseFor(floorNo);
        return !!l && l.wallet === me;
      };
      // Live data is for people with standing: the HQ's owner anywhere, a tenant
      // on their own floor. Everyone else — every floor, the HQ included — gets
      // the demo shift. The 3D office is the showroom; the data is the product.
      // Live standing, floor by floor: the HQ opens to its owner and to every
      // tenant (they are copying its calls); a leased floor opens to its tenant
      // and to anyone holding a paid guest pass; everything else is the demo.
      const floorPrivate = (floorNo) => {
        if (!me) return true;
        if (floorNo === HQ_FLOOR) return !(hqOwner(me) || leasing.leaseOf(me));
        const l = leasing.leaseFor(floorNo);
        if (!l) return true;
        return l.wallet !== me && !passes.passFor(floorNo, me);
      };
      const insider = () => !!me && (hqOwner(me) || !!leasing.leaseOf(me));

      const readBody = () => new Promise((resolve) => {
        let raw = ""; let over = false;
        req.on("data", (c) => { raw += c; if (raw.length > 8192) { over = true; req.destroy(); } });
        req.on("end", () => { if (over) return resolve(null); try { resolve(JSON.parse(raw || "{}")); } catch { resolve(null); } });
      });

      try {
        /* ── CODEX IMPROVEMENT ENGINEER ─────────────────────────────────────
         * This endpoint is intentionally aggregate-only and read-only. A separate
         * trusted worker may inspect this exact build and produce a proposal artifact;
         * the public trading process never starts Codex, accepts a patch, or exposes a
         * route that can apply/commit/deploy one. */
        if (url.pathname === "/api/improvements/status") {
          if (req.method !== "GET") return json(405, { error: "method not allowed" });
          return json(200, improvementServiceStatus());
        }
        if (url.pathname === "/api/improvements/review-bundle") {
          if (req.method !== "GET") return json(405, { error: "method not allowed" });
          const expected = process.env.CODEX_REVIEW_TOKEN || "";
          if (!expected) return json(503, { error: "improvement review bundle is not configured" });
          const supplied = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
          let authorized = false;
          try { authorized = Boolean(supplied) && cryptoTimingEqual(supplied, expected); } catch {}
          if (!authorized) return json(401, { error: "bad or missing review token" });
          res.setHeader("cache-control", "no-store");
          return json(200, currentImprovementBundle());
        }

        /* ── THE EXECUTOR FEED — a poller's read-only view of its floor's calls ──
           A tenant's OWN executor (their machine, their keys) polls this to
           learn what to trade. Authenticated by the floor's executor secret,
           compared in constant time. Read-only: this endpoint never trades,
           never signs, never touches a key — it just hands the bot the calls
           the desk already published, with everything a trade needs. This is
           how a tenant can use the same policy without handing us custody. The
           local poller defaults to paper mode and alone may run the explicit,
           independently gated live canary. */
        const feedMatch = url.pathname.match(/^\/api\/floor\/(\d+)\/executor\/feed$/);
        if (feedMatch) {
          const floorNo = Number(feedMatch[1]);
          const secret = db.prepare("SELECT executor_secret FROM copy_settings WHERE floor_no=?").get(floorNo)?.executor_secret;
          const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
          const okAuth = secret && auth && (() => {
            try { return cryptoTimingEqual(auth, secret); } catch { return false; }
          })();
          if (!okAuth) return json(401, { error: "bad or missing executor secret" });
          return json(200, executorFeedPayload(floorNo, url.searchParams.get("after") || 0));
        }

        /* ── EXECUTOR HEARTBEAT — outbound-only, self-reported liveness ──────
           The bot card refuses to claim WALL-ST-E is live without telemetry,
           which was honest and blind. This gives it eyes without giving the
           server hands: the poller POSTs a tiny status (mode, cursor, open
           count) on the same read-only secret; the site relays it AS
           self-reported. Still no control channel, no keys, no custody —
           the server cannot start, stop, or steer the executor with this. */
        const hbMatch = url.pathname.match(/^\/api\/floor\/(\d+)\/executor\/heartbeat$/);
        if (hbMatch && req.method === "POST") {
          const floorNo = Number(hbMatch[1]);
          const secret = db.prepare("SELECT executor_secret FROM copy_settings WHERE floor_no=?").get(floorNo)?.executor_secret;
          const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
          const okAuth = secret && auth && (() => {
            try { return cryptoTimingEqual(auth, secret); } catch { return false; }
          })();
          if (!okAuth) return json(401, { error: "bad or missing executor secret" });
          const body = await readBody();
          if (!body || typeof body !== "object") return json(400, { error: "malformed heartbeat" });
          const hb = {
            mode: String(body.mode ?? "").slice(0, 16),
            wallet: String(body.wallet ?? "").slice(0, 64),
            cursor: Number(body.cursor) || 0,
            open: Number(body.open) || 0,
            // Bounded and sanitised: a floor's own bot reporting which mints it holds.
            held: Array.isArray(body.held) ? body.held.slice(0, 20).map((h) => ({
              mint: String(h?.mint ?? "").slice(0, 64),
              sol: Number(h?.sol) || 0,
            })).filter((h) => h.mint) : [],
            ts: Number(body.ts) || Date.now(),
            seenAt: Date.now(),
          };
          db.prepare("UPDATE copy_settings SET executor_heartbeat=? WHERE floor_no=?")
            .run(JSON.stringify(hb), floorNo);
          return json(200, { ok: true });
        }

        /* ── RETIRED BROWSER RPC LANE ─────────────────────────────────────────
           The browser signer is not part of this release, so retaining even a
           read-only wildcard-CORS proxy would expose the private production RPC for
           no product benefit. Keep a deliberate tombstone response at the old path
           instead of forwarding any method or parameters upstream. */
        if (url.pathname === "/api/bot/rpc" && req.method === "POST") {
          const retired = retiredBrowserRpcResponse();
          return json(retired.status, retired.body);
        }

        /* One fixed, cheap RPC read for the one-signature buy: the public
           mainnet RPC 403s browsers, so the page gets its blockhash here,
           through the server's own RPC. Nothing user-controlled reaches the
           RPC; 5s memo-cache keeps a click-storm at one upstream call. */
        if (url.pathname === "/api/pay/blockhash") {
          const now = Date.now();
          if (!globalThis.__bh || now - globalThis.__bh.at > 5000) {
            const { readRpc } = await import("./lib/http.js");
            const { cfg: cfg3 } = await import("./config.js");
            const r = await readRpc(cfg3.rpc, "getLatestBlockhash", [{ commitment: "confirmed" }]);
            if (!r.ok) return json(502, { error: "rpc unavailable" });
            globalThis.__bh = { at: now, blockhash: r.data?.value?.blockhash };
          }
          return json(200, { blockhash: globalThis.__bh.blockhash });
        }

        if (url.pathname === "/api/lease/config") {
          // One-signature leasing: the client builds the SPL transfer itself,
          // so it needs the treasury's token account and the mint's program.
          try {
            if (!globalThis.__leasePayInfo) {
              const { treasuryTokenAccount } = await import("./scanner.js");
              const { readRpc } = await import("./lib/http.js");
              const { cfg: cfg2 } = await import("./config.js");
              const acct = await treasuryTokenAccount().catch(() => null);
              let program = null;
              if (acct) {
                const mi = await readRpc(cfg2.rpc, "getAccountInfo", [leasing.MINT, { encoding: "jsonParsed" }]);
                program = mi.ok ? mi.data?.value?.owner ?? null : null;
              }
              if (acct && program) globalThis.__leasePayInfo = { treasuryTokenAccount: acct, tokenProgram: program };
            }
          } catch {}
          return json(200, { ...leasing.config(), floors: tower.FLOORS, hq: tower.HQ_FLOOR, pay: globalThis.__leasePayInfo ?? null });
        }
        if (url.pathname === "/api/auth/nonce" && req.method === "POST") {
          const body = await readBody();
          if (!body?.wallet) return json(400, { error: "wallet required" });
          try { return json(200, auth.issueNonce(body.wallet)); }
          catch (e) { return json(400, { error: e.message }); }
        }
        if (url.pathname === "/api/auth/verify" && req.method === "POST") {
          const body = await readBody();
          if (!body?.wallet || !body?.nonce || !body?.signature) return json(400, { error: "wallet, nonce, signature required" });
          const r = auth.verifySignature({ wallet: body.wallet, nonce: body.nonce, signatureB58: body.signature });
          return json(r.ok ? 200 : 401, r);
        }
        if (url.pathname === "/api/auth/signout" && req.method === "POST") {
          if (bearer) auth.signOut(bearer);
          return json(200, { ok: true });
        }
        // Everything a floor needs to show its budget: what is credited, what it costs
        // to work, and where to send more.
        if (url.pathname === "/api/budget") {
          const cfgL = leasing.config();
          return json(200, {
            treasury: cfgL.treasury, mint: cfgL.mint, decimals: cfgL.decimals,
            floorPriceTokens: cfgL.priceTokens,
            runPriceTokens: rooms.RUN_PRICE_TOKENS,
            freeRunsWithLease: rooms.FREE_RUNS_WITH_LEASE,
            balanceBaseUnits: me ? leasing.balanceOf(me).toString() : "0",
            onchainBaseUnits: me ? await leasing.walletBalanceOf(me).then(String).catch(() => null) : null,
            credits: me ? leasing.creditsFor(me) : [],
            wallet: me ?? null,
          });
        }

        if (url.pathname === "/api/me") {
          if (!me) return json(401, { error: "not signed in" });
          const lease = leasing.leaseOf(me);
          // On-chain is best-effort: an RPC hiccup must not fail sign-in.
          const onchain = await leasing.walletBalanceOf(me).catch(() => null);
          return json(200, {
            wallet: me,
            onchainBaseUnits: onchain == null ? null : onchain.toString(),
            balanceBaseUnits: leasing.balanceOf(me).toString(),
            priceBaseUnits: leasing.PRICE_BASE_UNITS.toString(),
            decimals: leasing.DECIMALS,
            lease, credits: leasing.creditsFor(me),
          });
        }
        // ── the house call sheet ──
        if (url.pathname === "/api/calls" && !insider())
          return json(403, { private: true, error: "live calls are for tenants and the house" });
        if (url.pathname === "/api/calls/stats" && !insider())
          return json(403, { private: true });
        if (url.pathname === "/api/whales/feed" && !insider())
          return json(403, { private: true, error: "the whale feed is for tenants and the house" });
        if (url.pathname === "/api/chronicle" && !insider())
          return json(403, { private: true });
        if (url.pathname === "/api/calls") {
          return json(200, { live: calls.liveCalls(), recent: calls.recentCalls(20), stats: calls.stats() });
        }
        if (url.pathname === "/api/calls/stats") return json(200, calls.stats());

        // The house record, computed from chain data rather than self-reported.
        if (url.pathname === "/api/record") return json(200, perf.houseRecord());

        if (url.pathname === "/api/leaderboard") return json(200, { floors: identity.leaderboard() });

        if (url.pathname === "/api/chronicle") {
          return json(200, { events: chronicleRead({
            floor: url.searchParams.has("floor") ? Number(url.searchParams.get("floor")) : null,
            since: Number(url.searchParams.get("since") || 0),
            before: Number(url.searchParams.get("before") || 0),
            limit: Number(url.searchParams.get("limit") || 200),
            type: url.searchParams.get("type"),
            exclude: url.searchParams.get("exclude"),
          }) });
        }

        if (url.pathname === "/api/whales/feed") {
          const pad = url.searchParams.get("pad") || null;
          return json(200, { callouts: identity.whaleFeed({ launchpad: pad }) });
        }

        const chronFloor = url.pathname === "/api/chronicle" && url.searchParams.has("floor")
          ? Number(url.searchParams.get("floor")) : null;
        if (chronFloor != null && floorPrivate(chronFloor)) url.searchParams.delete("floor");

        const ledgerMatch = url.pathname.match(/^\/api\/(ledger|floor\/(\d+)\/ledger)$/);
        if (ledgerMatch) {
          const floorNo = ledgerMatch[2] != null ? Number(ledgerMatch[2]) : null;
          return json(200, identity.ledger({ floorNo }));
        }

        // ── a guest pass: pay the tenant, see the floor ──
        const passMatch = url.pathname.match(/^\/api\/floor\/(\d+)\/pass$/);
        if (passMatch) {
          const floorNo = Number(passMatch[1]);
          if (req.method === "GET") {
            const lease = leasing.leaseFor(floorNo);
            return json(200, {
              priceTokens: passes.PASS_TOKENS, days: passes.PASS_DAYS,
              payTo: lease?.wallet ?? null,
              yourPass: me ? passes.passFor(floorNo, me) : null,
            });
          }
          if (!me) return json(401, { error: "sign in with your wallet first" });
          if (!leasing.leaseOf(me) && !hqOwner(me))
            return json(403, { error: "guest passes are for tenants — lease a floor first" });
          const body = await readBody();
          const r = await passes.grantPass({ floorNo, viewer: me, signature: body?.signature });
          return json(r.ok ? 200 : 400, r);
        }

        /* ── the building's public books: proof the company works, for everyone ──
           Aggregates only — realised results, the house record, occupancy. The
           live edge stays subscription; the scoreboard is the shop window. */
        if (url.pathname === "/api/stats/overview") {
          const led = identity.ledger({ limit: 1 });
          const floors = identity.leaderboard(60);
          const occupancy = tower.summary();
          // The odometer: the receipts of the research machine, counted from its
          // own permanent record — never estimated, never decorative.
          const q = (sql) => { try { return db.prepare(sql).get()?.n ?? 0; } catch { return 0; } };
          const rows = (sql) => { try { return db.prepare(sql).all(); } catch { return []; } };
          return json(200, {
            building: {
              floorsTotal: occupancy.total,   // was hardcoded 50; tower.FLOORS is the truth
              floorsLeased: occupancy.floors.filter((f) => f.state === "owned").length,
              settledTrades: led.totals.floors.settled,
              realisedPnlUsd: led.totals.floors.pnl_usd,
              houseCalls: led.totals.house.calls,
              houseLive: led.totals.house.live ?? 0,
              houseClosedUp: led.totals.house.closed_up ?? 0,
              houseClosedDown: led.totals.house.closed_down ?? 0,
            },
            research: {
              grokEnabled: !!process.env.XAI_API_KEY,
              xReads: q("SELECT COUNT(*) n FROM llm_spend WHERE seat='XRead'"),
              coinsSeen: q("SELECT COUNT(*) n FROM seen"),
              seatVerdicts: q("SELECT COUNT(*) n FROM verdicts"),
              workups: q("SELECT COUNT(DISTINCT cycle || '-' || mint) n FROM verdicts"),
              killsByCode: q("SELECT COUNT(*) n FROM verdicts WHERE killed=1"),
              watchesOpened: q("SELECT COUNT(*) n FROM watchlist"),
              lessonsLearned: q("SELECT COUNT(*) n FROM lessons"),
            },
            /* THE SCREEN AS THE RUNNING PROCESS ACTUALLY HAS IT.
             * Every one of these is env-overridable, so editing the default in
             * config.js changes nothing if the deploy sets the variable. Publishing
             * the EFFECTIVE value is the difference between believing a threshold
             * changed and knowing it did. */
            screen: {
              minLiquidityUsd: cfg.screen.minLiquidityUsd,
            minMarketCapUsd: cfg.screen.minMarketCapUsd,
              minVolume24hUsd: cfg.screen.minVolume24hUsd,
              minTxns24h: cfg.screen.minTxns24h,
              minPairAgeHours: cfg.screen.minPairAgeHours,
              maxVolToLiqRatio: cfg.screen.maxVolToLiqRatio,
              maxFdvToLiqRatio: cfg.screen.maxFdvToLiqRatio,
              maxMarketCapUsd: cfg.screen.maxMarketCapUsd ?? null,
              exitProbeSizeUsd: cfg.targetSizeUsd,
              maxRoundTripPct: cfg.maxRoundTripSlippagePct,
              oneCallAtATime: mandate.SEQUENTIAL,
              maxLiveCalls: mandate.MAX_LIVE_CALLS,
              /* What each seat is actually worth to the composite. Published because
               * "we reweighted the desk toward the X read" is a claim about a running
               * process, and the only honest way to check it is to read the numbers
               * that process is holding. */
              seatWeights: cfg.weights,
            },
            /* WHICH BUILD IS ACTUALLY SERVING THIS.
             *
             * I have spent a day inferring deploy state from side effects — does this
             * event type exist yet, has that counter moved — and been wrong more than
             * once. Render sets RENDER_GIT_COMMIT on every deploy; publishing it turns
             * "is my fix live" from an inference into a lookup. A fix that is not
             * deployed and a fix that does not work look identical from out here, and
             * they need completely different responses. */
            build: {
              commit: (process.env.RENDER_GIT_COMMIT || "unknown").slice(0, 7),
              branch: process.env.RENDER_GIT_BRANCH || null,
              bootedAt: BOOTED_AT,
              upMins: Math.round((Date.now() - BOOTED_AT) / 60000),
            },
            /* THE FUNNEL, read from the funnel itself.
             *
             * This was briefly derived by summing chronicle events over a six-hour
             * window — a reasonable estimate of a pipeline that ran and emptied. The
             * desk now keeps a standing population instead, so the real counts exist
             * and can simply be read. Two sources for one truth is how they drift
             * apart, which has already cost a day once here. */
            funnel: (() => {
              try { return funnelCensus(); }
              catch (e) { return { error: String(e?.message || e) }; }
            })(),

            /* THE SHADOW BOOK — what the desk's REFUSALS went on to do.
             * The only honest answer to "we could have profited": a desk whose
             * refusals mostly die is calibrated; one whose refusals mostly double is
             * expensive, and this makes that a number instead of an argument. */
            shadow: (() => { try { return shadowBook.scorecard({ sinceH: 168 }); }
                             catch { return null; } })(),
            /* THE DEVELOPER LEDGER — what the desk remembers about who launched a coin.
             * It starts empty and fills as the desk works, so this is also the simplest
             * proof that the ledger deployed at all. */
            devLedger: {
              tracked: q("SELECT COUNT(*) n FROM dev_reputation"),
              ruggers: q("SELECT COUNT(*) n FROM dev_reputation WHERE verdict='serial_rugger'"),
              suspects: q("SELECT COUNT(*) n FROM dev_reputation WHERE verdict='suspect'"),
            },
            /* WHERE THE DESK ACTUALLY LANDS. "144 kills, 0 calls" says the gate held,
             * but not WHICH seat held it — and under the mandate that distinction is
             * the whole product. A PASS is the team naming a flaw in the trade; a HOLD
             * is only the team wanting more certainty, and the mandate ranks the second
             * rather than obeying it. Without this breakdown there was no way to tell
             * whether the desk was refusing on facts or on nerves. */
            decisions: {
              pm: rows("SELECT verdict, COUNT(*) n FROM verdicts WHERE seat='pm' AND verdict IS NOT NULL GROUP BY verdict ORDER BY n DESC"),
              ceo: rows("SELECT verdict, COUNT(*) n FROM verdicts WHERE seat='ceo' AND verdict IS NOT NULL GROUP BY verdict ORDER BY n DESC"),
              redteam: rows("SELECT verdict, COUNT(*) n FROM verdicts WHERE seat='redteam' AND verdict IS NOT NULL GROUP BY verdict ORDER BY n DESC"),
              /* THE CROSS-TAB THAT DECIDES WHETHER THE MANDATE IS ENOUGH.
               * A WATCH is tradeable under the mandate — unless the red team refuted
               * it and the PM never answered, which the mandate treats as a fact
               * rather than a view. So the only number that predicts whether the desk
               * can now publish is WATCH paired with a NON-refuted red team. Counting
               * PM verdicts and red-team verdicts separately cannot show that; they
               * have to be joined per coin. */
              /* WHY NOTHING PUBLISHED. The mandate refuses candidates for reasons it
               * emits as events, and every emit is chronicled — but the chronicle is
               * tenant-gated, so from the outside a desk that withholds looks exactly
               * like a desk that is idle. These two are different problems with
               * different fixes, and telling them apart needs the actual reason
               * string, not a count. Public because "why did my bot not trade" is
               * not a secret. `safety` separates a measured fact about the token from
               * a lack of conviction: only the second kind is ever tunable. */
              withheld: rows(`SELECT json_extract(data,'$.reason') reason,
                     json_extract(data,'$.safety') safety, COUNT(*) n,
                     MAX(ts) last_ts
                FROM chronicle
                WHERE type IN ('call:withheld','cohort:declined','call:rejected')
                  AND ts > (strftime('%s','now') * 1000 - 604800000)
                GROUP BY reason ORDER BY n DESC LIMIT 12`),
              /* WHY A SEAT DID NOT ANSWER.
               * `insufficient_coverage` is now the desk's single biggest refusal —
               * eight of nineteen — and it is not a judgement about a coin at all: it
               * means three of five analysts failed to answer and the desk correctly
               * refused to decide on a thin book. That costs money AND loses
               * candidates. ask() already retries 429/5xx three times with backoff, so
               * whatever is killing these is something else, and the only way to know
               * which is to read the actual error rather than guess at it. */
              seatFailures: rows(`SELECT json_extract(data,'$.seat') seat,
                     substr(json_extract(data,'$.error'), 1, 140) error, COUNT(*) n, MAX(ts) last_ts
                FROM chronicle
                WHERE type = 'seat:failed'
                  AND ts > (strftime('%s','now') * 1000 - 604800000)
                GROUP BY seat, error ORDER BY n DESC LIMIT 10`),
              /* And the retries that preceded them — a seat that burned all three
               * attempts looks identical, from the outside, to one that never tried. */
              seatRetries: rows(`SELECT json_extract(data,'$.seat') seat,
                     substr(json_extract(data,'$.error'), 1, 110) error, COUNT(*) n
                FROM chronicle
                WHERE type = 'seat:retry'
                  AND ts > (strftime('%s','now') * 1000 - 604800000)
                GROUP BY seat, error ORDER BY n DESC LIMIT 8`),

              /* WHAT DID THE RED TEAM ACTUALLY JUDGE?
               * It has said "survives" zero times in 52 — which reads as a broken seat
               * until you ask WHICH coins reached it. Those verdicts were collected
               * while rank() paid up to +39 for size alone, so the desk was surfacing
               * large, credible coins, and on a $40m coin "this will re-rate" is a weak
               * thesis that SHOULD be refuted. A pass rate is meaningless without the
               * population it was measured on, and the symbols are that population. */
              redteamSubjects: rows(`SELECT symbol, verdict, ts FROM verdicts
                WHERE seat='redteam' AND verdict IS NOT NULL AND symbol IS NOT NULL
                ORDER BY id DESC LIMIT 20`),

              /* DID THE CYCLE EVER GET TO CHOOSE?
               * 14 workups were eligible under the mandate and not one was published,
               * which can mean two completely different things: the cohort step ran and
               * found nothing it could publish, or it never ran because the cycle died
               * before reaching it. The events say which — cohort:ranked carries what
               * each cycle studied and who won. Without this the two failures are
               * indistinguishable from the outside, and they need opposite fixes. */
              cohort: rows(`SELECT json_extract(data,'$.studied') studied,
                     json_extract(data,'$.eligible') eligible,
                     json_extract(data,'$.winner.symbol') winner,
                     json_extract(data,'$.winner.tier') tier, ts
                FROM chronicle WHERE type='cohort:ranked'
                  AND ts > (strftime('%s','now') * 1000 - 604800000)
                ORDER BY ts DESC LIMIT 8`),

              /* And the three ways a cycle can end without a call at all. */
              cycleEnds: rows(`SELECT type, COUNT(*) n, MAX(ts) last_ts
                FROM chronicle
                WHERE type IN ('cycle:start','cycle:hunt_dry','cycle:holding','cycle:budget','cycle:halted','cycle:end','cycle:paced','cycle:prefiltered','cycle:replaced','cycle:skipped_repeats','cycle:all_recently_judged')
                  AND ts > (strftime('%s','now') * 1000 - 604800000)
                GROUP BY type ORDER BY n DESC`),
              pmVsRedteam: rows(`SELECT p.verdict pm, r.verdict redteam, COUNT(*) n
                FROM verdicts p JOIN verdicts r
                  ON p.cycle = r.cycle AND p.mint = r.mint AND r.seat = 'redteam'
                WHERE p.seat = 'pm' AND p.verdict IS NOT NULL
                GROUP BY p.verdict, r.verdict ORDER BY n DESC`),
              screenKills: rows("SELECT reason, COUNT(*) n FROM verdicts WHERE seat='Screener' AND killed=1 GROUP BY reason ORDER BY n DESC LIMIT 6"),
            },
            floors,
          });
        }

        // ── what a tenant gets to name: the floor, the MD, the costume ──
        const idMatch = url.pathname.match(/^\/api\/floor\/(\d+)\/identity$/);
        if (idMatch) {
          const floorNo = Number(idMatch[1]);
          if (req.method === "GET") return json(200, { identity: identity.identityFor(floorNo), costumes: identity.COSTUMES });
          if (!me) return json(401, { error: "sign in with your wallet first" });
          if (!holdsFloor(floorNo)) return json(403, { error: "this is not your floor" });
          const body = await readBody();
          const r = identity.setIdentity(floorNo, body || {});
          // Everyone watching this floor sees the new nameplate now, not on reload.
          if (r.ok) runFor(floorNo, () => emit("identity:changed",
            { floorNo, identity: r.identity, floorLabel: identity.ordinal(floorNo) }));
          return json(r.ok ? 200 : 400, r);
        }

        /* ── the heartbeat: is the desk alive, and if paused, why ────────── */
        if (url.pathname === "/api/heartbeat") {
          const q = (sql, ...a) => { try { return db.prepare(sql).get(...a); } catch { return null; } };
          const now = Date.now();
          const dayAgo = now - 86400e3;
          const sp = spendSince(dayAgo);
          const cap = cfg.dailyBudgetUsd;
          let state = "RUNNING", reason = null;
          if (process.env.PENTHOUSE_ENABLED === "0") { state = "PAUSED"; reason = "research disabled by the operator"; }
          else if (!process.env.ANTHROPIC_API_KEY) { state = "PAUSED"; reason = "no API key — the house team cannot work"; }
          else if (cap > 0 && sp.usd >= cap) { state = "PAUSED"; reason = `daily budget reached ($${sp.usd.toFixed(2)} of $${cap}) — monitoring and watch checks continue free`; }

          /* An empty provider balance is different from the desk's own daily cap.
           * Surface the provider event directly so the heartbeat cannot stay green
           * while every paid seat is refusing work. */
          const providerWindowMs = 6 * 3600e3;
          const providerEvents = (() => { try {
            return db.prepare(`SELECT type, ts, data FROM chronicle
              WHERE type IN ('desk:out_of_credit','seat:failed','seat:done') AND ts > ?
              ORDER BY ts DESC LIMIT 500`).all(now - providerWindowMs);
          } catch { return []; } })();
          const provider = providerCreditHealth(providerEvents, { nowMs: now, windowMs: providerWindowMs });
          if (provider.blocked) {
            state = "BLOCKED";
            /* Name WHICH provider wall was hit: an empty balance is topped up, a
             * metered ceiling is raised. Telling an operator to add credit when the
             * account has credit and a cap is what stopped them wastes the outage. */
            const ceiling = /metered provider ceiling|spend (?:cap|ceiling|limit)/i.test(provider.lastFailureError || "");
            reason = ceiling
              ? `the provider SPEND CEILING is reached (${provider.failures} refusal${provider.failures === 1 ? "" : "s"} in the last six hours) — ` +
                `the account has credit, but a configured limit is refusing new calls. Analyst seats fail individually, so calls get withheld ` +
                `as "fewer than three analysts returned" when the real cause is billing. Raise the limit in the Anthropic Console ` +
                `(Billing → Usage limits); free screening continues meanwhile.`
              : `the Anthropic account balance is empty (${provider.failures} provider-credit failure${provider.failures === 1 ? "" : "s"} in the last six hours) — ` +
                `this is the API account, NOT the desk's $${cap}/day cap, which still has $${Math.max(0, cap - sp.usd).toFixed(2)} of headroom. ` +
                `Top up the Anthropic account behind ANTHROPIC_API_KEY; free screening continues meanwhile.`;
          }
          /* IS THE PAID HALF ACTUALLY WORKING?
           *
           * RUNNING used to mean only "not paused" — the desk had budget, a key, and no
           * open position. It reported RUNNING for hours while every single workup threw
           * the same ReferenceError, because a failed workup is caught, counted, and
           * stepped over so one bad coin cannot end a cycle. That is right for one bad
           * coin and catastrophic for a bug on the shared path: cycles started, ran and
           * ended looking healthy while nothing was being researched at all.
           *
           * The tell was available the whole time and nobody was reading it — the SAME
           * error, on every token, every cycle. One coin failing is weather. Every coin
           * failing the same way is a broken build, and the heartbeat should say so
           * rather than leaving it to be inferred from counters that cannot tell
           * "not reached" from "failed". */
          const errRow = (() => { try {
            return db.prepare(`
              SELECT json_extract(data,'$.error') e, COUNT(*) n FROM chronicle
              WHERE type='cycle:error' AND ts > ? GROUP BY e ORDER BY n DESC LIMIT 1`
            ).get(now - 3600e3);
          } catch { return null; } })();
          if (state === "RUNNING" && errRow?.e && errRow.n >= 5) {
            state = "DEGRADED";
            reason = `${errRow.n} workups in the last hour failed identically: "${errRow.e}" — every coin failing the same way is a broken build, not a bad coin`;
          }

          /* WHY SEATS FAIL, in public.
           *
           * "fewer than three analysts returned" is the desk's 4th most common refusal —
           * 13 paid workups thrown away, gather and all, because three of five seats
           * could not answer. Each seat already retries three times on 429/5xx/parse, so
           * three failing TOGETHER is not flakiness; it is one shared cause firing five
           * times. Which cause was unreadable, because the error strings sat in the
           * private chronicle while the public counters only said "insufficient".
           *
           * That is the same shape as the outage this heartbeat just caught, so it gets
           * the same treatment: group the failures and say the reason out loud. */
          const seatFails = (() => { try {
            return db.prepare(`
              SELECT json_extract(data,'$.seat') seat, json_extract(data,'$.error') err,
                     COUNT(*) n, MAX(ts) last_ts
              FROM chronicle WHERE type='seat:failed' AND ts > ?
              GROUP BY seat, err ORDER BY n DESC LIMIT 5`).all(now - providerWindowMs);
          } catch { return []; } })();

          const lastEv = q("SELECT MAX(ts) t FROM chronicle")?.t ?? null;
          const cnt = (sql) => q(sql)?.n ?? 0;
          const live = calls.liveCalls();
          const marked = live.map((c) => {
            const m = q("SELECT mark FROM call_events WHERE call_id=? AND mark IS NOT NULL ORDER BY id DESC LIMIT 1", c.id)?.mark ?? null;
            return { id: c.id, symbol: c.symbol, entry: c.entry_ref, mark: m,
              pct: m != null && c.entry_ref ? Number((((m - c.entry_ref) / c.entry_ref) * 100).toFixed(1)) : null };
          });
          const settled = q("SELECT COUNT(*) n, COALESCE(SUM(pnl_usd),0) pnl, SUM(pnl_usd>0) w FROM results");
          return json(200, {
            state, reason, lastEventTs: lastEv, grokEnabled: !!process.env.XAI_API_KEY,
            providerCredit: {
              blocked: provider.blocked,
              failures: provider.failures,
              lastFailureTs: provider.lastFailureTs,
              lastSuccessTs: provider.lastSuccessTs,
              recoveryGraceMs: provider.recoveryGraceMs,
            },
            /* The desk's own failures, not the market's. Anything here is the desk
             * losing paid work to its own plumbing. */
            seatFailures6h: seatFails.map((r) => ({
              seat: r.seat,
              n: r.n,
              lastTs: r.last_ts ?? null,
              error: String(r.err ?? "").slice(0, 160),
            })),
            withheldToday: (() => { try {
              return db.prepare(`
                SELECT reason, COUNT(*) n FROM chronicle
                WHERE type='call:withheld' AND ts > ?
                GROUP BY json_extract(data,'$.reason') ORDER BY n DESC LIMIT 6`).all(dayAgo)
                .map((r) => { let x = r.reason; try { x = JSON.parse(r.reason); } catch {}
                              return { n: r.n, reason: String(x?.reason ?? x ?? "").slice(0, 120) }; });
            } catch { return []; } })(),
            today: {
              workups: cnt(`SELECT COUNT(DISTINCT cycle||'-'||mint) n FROM verdicts WHERE ts > ${dayAgo}`),
              kills: cnt(`SELECT COUNT(*) n FROM verdicts WHERE killed=1 AND ts > ${dayAgo}`),
              watches: cnt(`SELECT COUNT(*) n FROM watchlist WHERE created_at > ${dayAgo}`),
              xReads: cnt(`SELECT COUNT(*) n FROM llm_spend WHERE seat='XRead' AND ts > ${dayAgo}`),
              spendUsd: Number(sp.usd.toFixed(2)), capUsd: cap,
            },
            pnl: {
              realizedUsd: Number((settled?.pnl ?? 0).toFixed(2)),
              settled: settled?.n ?? 0, wins: settled?.w ?? 0, losses: (settled?.n ?? 0) - (settled?.w ?? 0),
              researchSpendAllTimeUsd: Number((spendSince(0).usd).toFixed(2)),
              openCalls: marked,
            },
          });
        }

        /* ── the killed lane: the trades that did NOT happen, with receipts ── */
        if (url.pathname === "/api/killed" && !insider())
          return json(403, { error: "the kill record is for tenants — lease a floor" });
        if (url.pathname === "/api/killed") {
          const kills = db.prepare(`SELECT mint, symbol, seat, reason, MAX(ts) ts FROM verdicts
            WHERE killed=1 GROUP BY mint ORDER BY ts DESC LIMIT 14`).all();
          const out = kills.map((k) => {
            const at = db.prepare("SELECT price FROM snapshots WHERE mint=? AND ts<=? ORDER BY ts DESC LIMIT 1").get(k.mint, k.ts)?.price ?? null;
            const now = db.prepare("SELECT price FROM snapshots WHERE mint=? ORDER BY ts DESC LIMIT 1").get(k.mint)?.price ?? null;
            return { ...k, sinceKillPct: at && now ? Number((((now - at) / at) * 100).toFixed(1)) : null };
          });
          return json(200, { kills: out });
        }

        /* ── the dossier: one call's whole story, kept forever ───────────── */
        const dossierMatch = url.pathname.match(/^\/api\/call\/(\d+)\/dossier$/);
        if (dossierMatch && !insider())
          return json(403, { error: "call dossiers are for tenants — lease a floor" });
        if (dossierMatch) {
          const call = calls.getCall(Number(dossierMatch[1]));
          if (!call) return json(404, { error: "no such call" });
          const win = 50 * 60e3;
          const verdicts = db.prepare(`SELECT seat,verdict,score,confidence,killed,reason,json,ts FROM verdicts
            WHERE mint=? AND ts BETWEEN ? AND ? ORDER BY ts`).all(call.mint, call.opened_at - win, call.opened_at + 5 * 60e3);
          const events = db.prepare("SELECT kind,detail,mark,ts FROM call_events WHERE call_id=? ORDER BY id").all(call.id);
          const fills = db.prepare("SELECT floor_no,side,token_units,quote_usd,signature,block_time FROM fills WHERE call_id=? ORDER BY id").all(call.id);
          const results = db.prepare("SELECT floor_no,pnl_usd,fee_usd,settled_at FROM results WHERE call_id=?").all(call.id);
          const lesson = db.prepare("SELECT grade,lesson,ts FROM lessons WHERE call_id=? ORDER BY id DESC LIMIT 1").get(call.id) ?? null;
          // The research bill for THIS call, from the verdict window.
          let costUsd = null;
          if (verdicts.length) {
            const t0 = verdicts[0].ts - 120e3, t1 = verdicts[verdicts.length - 1].ts + 120e3;
            costUsd = db.prepare("SELECT COALESCE(SUM(usd),0) u FROM llm_spend WHERE ts BETWEEN ? AND ?").get(t0, t1)?.u ?? null;
            if (costUsd != null) costUsd = Number(costUsd.toFixed(3));
          }
          let report = null;
          if (call.report_file) {
            try {
              const f = path.join(ROOT, call.report_file);
              if (f.startsWith(ROOT) && fs.existsSync(f)) report = fs.readFileSync(f, "utf8").slice(0, 60_000);
            } catch {}
          }
          const seats = verdicts.map((v) => {
            let extract = null;
            try { const j = JSON.parse(v.json || "{}"); extract = j.headline ?? j.thesis ?? j.size_rationale ?? null; } catch {}
            return { seat: v.seat, verdict: v.verdict, score: v.score, confidence: v.confidence,
              killed: !!v.killed, reason: v.reason, extract, ts: v.ts };
          });
          return json(200, { call, seats, events, fills, results, lesson, costUsd, report });
        }

        /* ── the glass desk: every decision, seat by seat ──────────────────
           The verdicts table already holds the whole story of every coin the
           desk examined — every seat's score, confidence, kill and reasoning.
           This surfaces it: the trail a tenant reads to answer "why did my
           team decide that". Insider-gated like calls: transparency is the
           tenant's product; the public gets the odometer and the books. */
        if (url.pathname === "/api/activity" && !insider())
          return json(403, { error: "the decision trail is for tenants — lease a floor" });
        if (url.pathname === "/api/activity") {
          const floorQ = url.searchParams.get("floor");
          const like = floorQ ? `floor${Number(floorQ)}-%` : null;
          const rows = like
            ? db.prepare("SELECT cycle,mint,symbol,seat,verdict,score,confidence,killed,reason,json,ts FROM verdicts WHERE cycle LIKE ? ORDER BY id DESC LIMIT 400").all(like)
            : db.prepare("SELECT cycle,mint,symbol,seat,verdict,score,confidence,killed,reason,json,ts FROM verdicts ORDER BY id DESC LIMIT 400").all();
          const byKey = new Map();
          for (const r of rows) {
            const k = r.cycle + "|" + r.mint;
            if (!byKey.has(k)) byKey.set(k, { cycle: r.cycle, mint: r.mint, symbol: r.symbol, ts: r.ts, seats: [] });
            const g = byKey.get(k);
            g.ts = Math.min(g.ts, r.ts);
            let extract = null;
            try {
              const j = JSON.parse(r.json || "{}");
              extract = j.headline ?? j.thesis ?? j.size_rationale ?? j.ruling ?? null;
              if (r.seat === "pm" && j.how_red_team_was_answered)
                extract = (extract ? extract + " " : "") + "· RT answered: " + j.how_red_team_was_answered;
            } catch {}
            g.seats.push({ seat: r.seat, verdict: r.verdict, score: r.score,
              confidence: r.confidence, killed: !!r.killed, reason: r.reason, extract, ts: r.ts });
          }
          const workups = [...byKey.values()].slice(0, 24)
            .map((w) => ({ ...w, seats: w.seats.sort((a, b) => a.ts - b.ts) }));
          return json(200, { workups });
        }

        // The watch board: every armed tripwire and its LIVE distance to firing.
        if (url.pathname === "/api/watchboard" && !insider())
          return json(403, { error: "the watch board is for tenants — lease a floor" });
        if (url.pathname === "/api/watchboard") {
          const ws = db.prepare("SELECT id,mint,symbol,rules,note,created_at,expires_at,status,held_count,last_checked FROM watchlist ORDER BY id DESC LIMIT 30").all();
          const out = ws.map((w) => {
            const rules = JSON.parse(w.rules || "{}");
            const snap = db.prepare("SELECT price, liq, buys, sells, ts FROM snapshots WHERE mint=? ORDER BY ts DESC LIMIT 1").get(w.mint);
            return { ...w, rules, now: snap ? { priceUsd: snap.price, liqUsd: snap.liq,
              buysH24: snap.buys, asOf: snap.ts } : null };
          });
          return json(200, { watches: out });
        }

        /* ── whale CALLOUTS: pump.fun's on-site calls on the coins whales sized into ──
           A callout is a wallet posting a thesis on the coin's own page; the site
           tracks the multiple since. An author whose wallet is among the pool's
           recent big buyers is a WHALE (ranked by dollars taken); the rest rank
           by their tracked multiple. Cached 2 minutes — this fans out to
           pump.fun and the RPC. */
        if (url.pathname === "/api/whales/callouts" && !insider())
          return json(403, { error: "whale callouts are insider data — lease a floor" });
        if (url.pathname === "/api/whales/callouts") {
          const now = Date.now();
          if (globalThis.__whaleCallouts && now - globalThis.__whaleCallouts.at < 120e3)
            return json(200, globalThis.__whaleCallouts.body);
          const feed = identity.whaleFeed({ launchpad: "pump.fun", limit: 40 });
          const seen = new Set();
          const mints = feed.filter((w) => w.mint && !seen.has(w.mint) && seen.add(w.mint)).slice(0, 3);
          const pf = await import("./data/pumpfun.js");
          const { callouts: liveWhales } = await import("./whales.js");
          const out = [];
          for (const m of mints) {
            const [thread, flow] = await Promise.all([
              pf.callouts(m.mint, 20).catch(() => ({ ok: false, callouts: [] })),
              liveWhales(m.mint, { scan: 16 }).catch(() => null),
            ]);
            if (!thread.ok) continue;
            const buyers = new Map();
            for (const t of flow?.trades ?? [])
              if (t.side === "buy" && t.wallet) buyers.set(t.wallet, (buyers.get(t.wallet) ?? 0) + (t.usd ?? 0));
            const quotes = thread.callouts.map((q) => ({ ...q, whaleUsd: buyers.get(q.user) ?? 0 }));
            const whales = quotes.filter((q) => q.whaleUsd > 0)
              .sort((x, y) => y.whaleUsd - x.whaleUsd).slice(0, 3);
            const chatter = quotes.filter((q) => q.whaleUsd === 0)
              .sort((x, y) => (y.multiple ?? 0) - (x.multiple ?? 0)).slice(0, 3);
            if (whales.length + chatter.length === 0) continue;
            out.push({ mint: m.mint, symbol: m.symbol, netUsd: m.net_usd ?? null, whales, chatter });
          }
          const body2 = { coins: out };
          globalThis.__whaleCallouts = { at: now, body: body2 };
          return json(200, body2);
        }

        // Whale callouts for one mint, read live off the pool.
        const whaleMatch = url.pathname.match(/^\/api\/whales\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
        if (whaleMatch) return json(200, await callouts(whaleMatch[1], { scan: 24 }));

        const alertMatch = url.pathname.match(/^\/api\/floor\/(\d+)\/alerts(\/ack)?$/);
        if (alertMatch) {
          const floorNo = Number(alertMatch[1]);
          if (!alertMatch[2]) {
            if (floorPrivate(floorNo)) return json(403, { private: true, error: "tenant only" });
            return json(200, { unread: alerts.unreadFor(floorNo), recent: alerts.recentFor(floorNo) });
          }
          if (!me) return json(401, { error: "sign in with your wallet first" });
          if (!holdsFloor(floorNo)) return json(403, { error: "this is not your floor" });
          const body = await readBody();
          return json(200, { acknowledged: alerts.acknowledge(floorNo, body?.ids) });
        }

        const perfMatch = url.pathname.match(/^\/api\/floor\/(\d+)\/(record|sync)$/);
        if (perfMatch) {
          const floorNo = Number(perfMatch[1]);
          if (perfMatch[2] === "record") return json(200, perf.recordFor(floorNo));
          // sync: follow the owner's own wallet and record any fills on their calls
          if (!me) return json(401, { error: "sign in with your wallet first" });
          if (!holdsFloor(floorNo)) return json(403, { error: "this is not your floor" });
          const taken = copy.feedFor(floorNo, 40).filter((d) => d.verdict === "offered");
          let scanned = 0, settled = 0;
          for (const d of taken) {
            const r = await perf.scanFills({ floorNo, callId: d.call_id, wallet: me, mint: d.mint });
            if (r.ok) scanned += r.fills ?? 0;
            const s2 = await perf.settle({ floorNo, callId: d.call_id, wallet: me });
            if (s2.ok) settled++;
          }
          return json(200, { ok: true, fillsFound: scanned, settled, record: perf.recordFor(floorNo) });
        }

        // ── a floor's copy settings and its personal feed ──
        const copyMatch = url.pathname.match(/^\/api\/floor\/(\d+)\/(copy|feed|take)$/);
        if (copyMatch) {
          const floorNo = Number(copyMatch[1]);
          const what = copyMatch[2];
          if (what === "feed" && req.method === "GET") {
            if (floorPrivate(floorNo)) return json(403, { private: true,
              error: "this floor's live desk is private to its tenant" });
            // A guest pass buys the CALL SHEET, not the tenant's credentials:
            // webhook URLs and the executor signing secret are the owner's only.
            /* THE HQ HAS NO LEASE, SO ITS OWNER FAILED THE OWNER CHECK.
             *
             * This read `leaseFor(floorNo)?.wallet === me`, and floor 50 is never for
             * sale — leaseFor(50) is null, so the check was false for everyone
             * including the boss. The HQ owner was handed `executor_secret: null` and
             * could not obtain the credential their own bot authenticates with, on
             * the one floor they definitely own. Same test the rest of this file
             * already uses for HQ standing. */
            const isOwner = !!me && (floorNo === HQ_FLOOR
              ? hqOwner(me)
              : leasing.leaseFor(floorNo)?.wallet === me);
            const st = copy.settingsFor(floorNo);
            const settings = isOwner ? st
              : { ...st, webhook_url: st.webhook_url ? "(set)" : null,
                  executor_url: st.executor_url ? "(set)" : null, executor_secret: null };
            return json(200, { feed: copy.feedFor(floorNo), settings,
                               appetites: copy.APPETITES, rent: leasing.rentStatus(floorNo),
                               record: perf.recordFor(floorNo) });
          }
          if (!me) return json(401, { error: "sign in with your wallet first" });
          const lease = leasing.leaseFor(floorNo);
          // Floor 50 carries no lease row — it is the house's own desk — so its
          // owners were refused their own copy settings, executor secret
          // included. Same house seat the room routes already honour.
          if (!holdsFloor(floorNo)) return json(403, { error: "this is not your floor" });
          const body = await readBody();
          if (what === "copy") {
            if (body && "webhookUrl" in body) {
              const v = alerts.validWebhook(body.webhookUrl || null);
              if (!v.ok) return json(400, { error: `webhook: ${v.error}` });
              body.webhookUrl = v.url;
            }
            if (body && "executorUrl" in body) {
              const v = alerts.validExecutorUrl(body.executorUrl || null);
              if (!v.ok) return json(400, { error: `executor: ${v.error}` });
              body.executorUrl = v.url;
            }
            return json(200, copy.saveSettings(floorNo, body || {}));
          }
          if (what === "take") {
            const ok = copy.markTaken(floorNo, Number(body?.callId), body?.taken !== false);
            return json(ok ? 200 : 404, { ok });
          }
        }

        const roomMatch = url.pathname.match(/^\/api\/floor\/(\d+)(\/settings|\/run)?$/);
        if (roomMatch) {
          const floorNo = Number(roomMatch[1]);
          const action = roomMatch[2];
          // The penthouse is never LEASED — it is the house's own desk, and its
          // owners (treasury, the dev wallet, the deed) sit in it as tenants do.

          if (!action) return json(200, rooms.roomState(floorNo, me, { houseSeat: holdsFloor(floorNo) }));

          if (!me) return json(401, { error: "sign in with your wallet first" });
          const lease = leasing.leaseFor(floorNo);
          if (!holdsFloor(floorNo)) return json(403, { error: "this is not your floor" });

          const body = await readBody();
          if (action === "/settings") return json(200, rooms.saveSettings(floorNo, body || {}));
          if (action === "/run") {
            const r = await rooms.requestRun({ floorNo, wallet: me, mint: body?.mint, houseSeat: holdsFloor(floorNo) });
            return json(r.ok ? 200 : 409, r);
          }
        }

        if (url.pathname === "/api/lease/allocate" && req.method === "POST") {
          if (!me) return json(401, { error: "sign in with your wallet first" });
          const body = await readBody();
          const r = leasing.allocate({ wallet: me, floorNo: body?.floorNo, name: body?.name ?? null });
          return json(r.ok ? 200 : 409, r);
        }
      } catch (e) {
        return json(500, { error: String(e.message) });
      }
    }

    if (url.pathname === "/api/tower/floors") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(tower.summary()));
      return;
    }

    if (url.pathname === "/state") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ spend, stats: store.stats(), ledger: store.ledger(10) }));
      return;
    }

    // Serve three.js from node_modules during local development. The published
    // artifact inlines it instead (scripts/build-viewer.mjs), because the artifact
    // CSP forbids any external fetch.
    if (url.pathname.startsWith("/vendor/three/")) {
      const name = path.basename(url.pathname);
      const tf = path.join(ROOT, "node_modules", "three", "build", name);
      if (fs.existsSync(tf) && /^three\.[\w.]+\.js$/.test(name)) {
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
        res.end(fs.readFileSync(tf));
        return;
      }
      res.writeHead(404); res.end("no such three build"); return;
    }

    // Routes: / is the site, /tower is the building, /floor/N is one desk's trading floor.
    let page = url.pathname.slice(1);
    if (url.pathname === "/") page = "index.html";
    else if (url.pathname === "/tower") page = "tower.html";
    else if (/^\/floor\/\d+$/.test(url.pathname)) page = "office3d.html";
    else if (url.pathname === "/buy") page = "buy.html";
    // The executor's own files, served read-only. The floor page imports
    // strategy.mjs directly so its paper test runs the REAL risk engine, and the
    // one-command installer curls poller.mjs — both resolve from the built site
    // in production, so serve them here too or local drifts from live.
    if (url.pathname.startsWith("/executor/")) {
      const name = path.basename(url.pathname);
      const ef = path.join(ROOT, "executor", name);
      if (!ef.startsWith(path.join(ROOT, "executor") + path.sep) || !fs.existsSync(ef) || !fs.statSync(ef).isFile()) {
        res.writeHead(404); res.end("not found"); return;
      }
      res.writeHead(200, { "content-type": name.endsWith(".mjs") ? "text/javascript; charset=utf-8" : "text/plain; charset=utf-8" });
      res.end(fs.readFileSync(ef));
      return;
    }

    const file = path.join(ROOT, "viewer", page);
    if (!file.startsWith(path.join(ROOT, "viewer")) || !fs.existsSync(file)) {
      res.writeHead(404); res.end("not found"); return;
    }
    const type = file.endsWith(".html") ? "text/html; charset=utf-8" : file.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/plain; charset=utf-8";
    res.writeHead(200, { "content-type": type });
    res.end(fs.readFileSync(file));
  });

  server.listen(port);
  return { server, url: `http://localhost:${port}` };
}
