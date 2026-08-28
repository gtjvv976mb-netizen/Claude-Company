import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";
import { bus, backlog } from "./lib/bus.js";
import { spend } from "./lib/llm.js";
import * as store from "./lib/store.js";
import * as tower from "./tower.js";
import * as auth from "./auth.js";
import * as leasing from "./leasing.js";
import * as rooms from "./rooms.js";

/** Serves the trading floor and streams the desk's real events to it. */
export function startOffice(port = Number(process.env.PORT) || 4949) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    if (url.pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      // ?floor=N gives a tenant only their own desk's work; no argument is the house view.
      const wantFloor = url.searchParams.has("floor") ? Number(url.searchParams.get("floor")) : null;
      res.write(`event: hello\ndata: ${JSON.stringify({ backlog: backlog(wantFloor), floor: wantFloor })}\n\n`);
      const onEvent = (ev) => {
        if (wantFloor != null && ev.floor !== wantFloor) return;
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
