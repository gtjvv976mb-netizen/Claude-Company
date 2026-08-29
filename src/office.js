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
            credits: me ? leasing.creditsFor(me) : [],
            wallet: me ?? null,
          });
        }

        if (url.pathname === "/api/me") {
          if (!me) return json(401, { error: "not signed in" });
          const lease = leasing.leaseOf(me);
          return json(200, {
            wallet: me,
            balanceBaseUnits: leasing.balanceOf(me).toString(),
            priceBaseUnits: leasing.PRICE_BASE_UNITS.toString(),
            decimals: leasing.DECIMALS,
            lease, credits: leasing.creditsFor(me),
          });
        }
        // ── the house call sheet ──
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
            limit: Number(url.searchParams.get("limit") || 200),
            type: url.searchParams.get("type"),
          }) });
        }

        if (url.pathname === "/api/whales/feed") {
          const pad = url.searchParams.get("pad") || null;
          return json(200, { callouts: identity.whaleFeed({ launchpad: pad }) });
        }

        const ledgerMatch = url.pathname.match(/^\/api\/(ledger|floor\/(\d+)\/ledger)$/);
        if (ledgerMatch) {
          const floorNo = ledgerMatch[2] != null ? Number(ledgerMatch[2]) : null;
          return json(200, identity.ledger({ floorNo }));
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
