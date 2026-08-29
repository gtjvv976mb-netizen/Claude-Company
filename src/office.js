import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";
import { bus, backlog, emit, runFor, chronicleRead } from "./lib/bus.js";
import { spend } from "./lib/llm.js";
import * as store from "./lib/store.js";
import * as tower from "./tower.js";
import * as auth from "./auth.js";
import * as leasing from "./leasing.js";
import * as rooms from "./rooms.js";
import * as calls from "./calls.js";
import * as copy from "./copy.js";
import * as perf from "./perf.js";
import * as alerts from "./alerts.js";
import * as identity from "./identity.js";
import * as passes from "./passes.js";
import { callouts } from "./whales.js";

/** Serves the trading floor and streams the desk's real events to it. */
export function startOffice(port = Number(process.env.PORT) || 4949) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    // The site and the API are on different origins by design (static host + Render), so
    // every response needs these — not just the /api/ ones. /events did not have them,
    // which silently dropped every floor back to the demo feed.
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type,authorization");
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    if (url.pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      // ?floor=N gives a tenant only their own desk's work; no argument is the house view.
      const wantFloor = url.searchParams.has("floor") ? Number(url.searchParams.get("floor")) : null;
      // EventSource cannot send headers, so the tenant's token rides the query
      // string (same-origin HTTPS). A visitor to a leased floor is told plainly
      // and the stream ends — the client runs its demo shift instead.
      {
        const sid = url.searchParams.get("sid");
        const who = sid ? auth.walletFor(sid) : null;
        const isHq = (w) => !!w && (w === leasing.TREASURY || w === (process.env.HQ_OWNER || "")
          || tower.getFloor(50)?.owner === w);
        let allowed;
        if (wantFloor == null || wantFloor === 50) allowed = isHq(who) || (!!who && !!leasing.leaseOf(who));
        else {
          const l = leasing.leaseFor(wantFloor);
          allowed = !!l && !!who && (l.wallet === who || !!passes.passFor(wantFloor, who));
        }
        if (!allowed) {
          const l = wantFloor != null && wantFloor !== 50 ? leasing.leaseFor(wantFloor) : true;
          res.write(`event: hello\ndata: ${JSON.stringify({ private: true, hq: wantFloor == null || wantFloor === 50, vacant: !l, floor: wantFloor })}\n\n`);
          res.end();
          return;
        }
      }
      res.write(`event: hello\ndata: ${JSON.stringify({ backlog: backlog(wantFloor), floor: wantFloor })}\n\n`);
      // A room shows two things at once: the HOUSE desk working (floor null, the same
      // for every visitor) and that floor's own activity. Filtering strictly to the floor
      // hid the house team entirely, so every room looked idle while the desk was busy.
      const onEvent = (ev) => {
        if (wantFloor != null && ev.floor != null && ev.floor !== wantFloor) return;
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
          "access-control-allow-headers": "content-type,authorization" });
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
      const hqOwner = (w) => !!w && (w === leasing.TREASURY || w === (process.env.HQ_OWNER || "")
        || tower.getFloor(HQ_FLOOR)?.owner === w);
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
        if (url.pathname === "/api/lease/config") {
          return json(200, { ...leasing.config(), floors: tower.FLOORS, hq: tower.HQ_FLOOR });
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
          return json(200, {
            building: {
              floorsTotal: 50,
              floorsLeased: occupancy.floors.filter((f) => f.state === "owned").length,
              settledTrades: led.totals.floors.settled,
              realisedPnlUsd: led.totals.floors.pnl_usd,
              houseCalls: led.totals.house.calls,
              houseLive: led.totals.house.live ?? 0,
              houseClosedUp: led.totals.house.closed_up ?? 0,
              houseClosedDown: led.totals.house.closed_down ?? 0,
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
          const lease = leasing.leaseFor(floorNo);
          if (!lease || lease.wallet !== me) return json(403, { error: "this is not your floor" });
          const body = await readBody();
          const r = identity.setIdentity(floorNo, body || {});
          // Everyone watching this floor sees the new nameplate now, not on reload.
          if (r.ok) runFor(floorNo, () => emit("identity:changed",
            { floorNo, identity: r.identity, floorLabel: identity.ordinal(floorNo) }));
          return json(r.ok ? 200 : 400, r);
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
          const lease = leasing.leaseFor(floorNo);
          if (!lease || lease.wallet !== me) return json(403, { error: "this is not your floor" });
          const body = await readBody();
          return json(200, { acknowledged: alerts.acknowledge(floorNo, body?.ids) });
        }

        const perfMatch = url.pathname.match(/^\/api\/floor\/(\d+)\/(record|sync)$/);
        if (perfMatch) {
          const floorNo = Number(perfMatch[1]);
          if (perfMatch[2] === "record") return json(200, perf.recordFor(floorNo));
          // sync: follow the owner's own wallet and record any fills on their calls
          if (!me) return json(401, { error: "sign in with your wallet first" });
          const lease = leasing.leaseFor(floorNo);
          if (!lease || lease.wallet !== me) return json(403, { error: "this is not your floor" });
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
            return json(200, { feed: copy.feedFor(floorNo), settings: copy.settingsFor(floorNo),
                               appetites: copy.APPETITES, rent: leasing.rentStatus(floorNo),
                               record: perf.recordFor(floorNo) });
          }
          if (!me) return json(401, { error: "sign in with your wallet first" });
          const lease = leasing.leaseFor(floorNo);
          if (!lease || lease.wallet !== me) return json(403, { error: "this is not your floor" });
          const body = await readBody();
          if (what === "copy") {
            if (body && "webhookUrl" in body) {
              const v = alerts.validWebhook(body.webhookUrl || null);
              if (!v.ok) return json(400, { error: `webhook: ${v.error}` });
              body.webhookUrl = v.url;
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
          if (!action) return json(200, rooms.roomState(floorNo, me));

          if (!me) return json(401, { error: "sign in with your wallet first" });
          const lease = leasing.leaseFor(floorNo);
          if (!lease || lease.wallet !== me) return json(403, { error: "this is not your floor" });

          const body = await readBody();
          if (action === "/settings") return json(200, rooms.saveSettings(floorNo, body || {}));
          if (action === "/run") {
            const r = await rooms.requestRun({ floorNo, wallet: me, mint: body?.mint });
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
