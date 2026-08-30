import db, { ensureColumn } from "./lib/store.js";
import { runFor, emit } from "./lib/bus.js";
import { leaseFor, leaseOf, balanceOf, DECIMALS } from "./leasing.js";
import { workup } from "./desk.js";
import { identityFor, ordinal } from "./identity.js";

/**
 * A floor is a rented desk, not a window onto someone else's.
 *
 * Each floor has its own settings, its own journal, and its own research runs, which the
 * tenant triggers and pays for in $CLAUDECO. Runs are metered rather than continuous for
 * a reason worth stating plainly: fourteen Opus seats per token costs real money, and a
 * one-time lease cannot fund unlimited compute. Metering is what keeps the promise honest.
 */

export const RUN_PRICE_TOKENS = Number(process.env.RUN_PRICE_CLAUDECO || 250_000);
export const RUN_PRICE_BASE_UNITS = BigInt(Math.round(RUN_PRICE_TOKENS)) * 10n ** BigInt(DECIMALS);
export const FREE_RUNS_WITH_LEASE = Number(process.env.FREE_RUNS_WITH_LEASE || 5);

db.exec(`
CREATE TABLE IF NOT EXISTS room_settings (
  floor_no    INTEGER PRIMARY KEY REFERENCES floors(n),
  desk_name   TEXT,
  risk_pct    REAL DEFAULT 1.0,
  equity_usd  REAL DEFAULT 10000,
  watchlist   TEXT DEFAULT '[]',
  updated_at  INTEGER
);
CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  floor_no    INTEGER NOT NULL,
  wallet      TEXT NOT NULL,
  mint        TEXT NOT NULL,
  symbol      TEXT,
  outcome     TEXT,
  detail      TEXT,
  paid        TEXT NOT NULL DEFAULT '0',
  free_run    INTEGER NOT NULL DEFAULT 0,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runs_floor ON runs(floor_no, id DESC);
`);
// Take a break / let's grind: 'break' = the team works only when asked;
// 'grind' = it hunts on its own clock for as long as the credit lasts.
ensureColumn("room_settings", "mode", "TEXT NOT NULL DEFAULT 'break'");
ensureColumn("room_settings", "grind_hours", "REAL NOT NULL DEFAULT 4");
// Which brain manages this floor: Claude (default) or Grok, per the owner.
ensureColumn("room_settings", "md_brain", "TEXT NOT NULL DEFAULT 'claude'");

export function settings(floorNo) {
  let s = db.prepare("SELECT * FROM room_settings WHERE floor_no=?").get(floorNo);
  if (!s) {
    db.prepare("INSERT INTO room_settings (floor_no, updated_at) VALUES (?,?)").run(floorNo, Date.now());
    s = db.prepare("SELECT * FROM room_settings WHERE floor_no=?").get(floorNo);
  }
  return { ...s, watchlist: JSON.parse(s.watchlist || "[]") };
}

export function saveSettings(floorNo, patch) {
  const cur = settings(floorNo);
  const next = {
    desk_name: patch.deskName ?? cur.desk_name,
    risk_pct: Math.min(10, Math.max(0.1, Number(patch.riskPct ?? cur.risk_pct))),
    equity_usd: Math.max(0, Number(patch.equityUsd ?? cur.equity_usd)),
    watchlist: JSON.stringify((patch.watchlist ?? cur.watchlist).slice(0, 25)),
    mode: patch.mode === "grind" || patch.mode === "break" ? patch.mode : cur.mode,
    md_brain: patch.mdBrain === "grok" || patch.mdBrain === "claude" ? patch.mdBrain : cur.md_brain,
    grind_hours: Math.min(24, Math.max(1, Number(patch.grindHours ?? cur.grind_hours))),
  };
  db.prepare(`UPDATE room_settings SET desk_name=?, risk_pct=?, equity_usd=?, watchlist=?, mode=?, grind_hours=?, md_brain=?, updated_at=?
              WHERE floor_no=?`)
    .run(next.desk_name, next.risk_pct, next.equity_usd, next.watchlist, next.mode, next.grind_hours, next.md_brain, Date.now(), floorNo);
  if (patch.mode) emit("room:mode", { floor: floorNo, mode: next.mode });
  return settings(floorNo);
}

/** Floors currently grinding, with what they need for the auto-run decision. */
export function grindingFloors() {
  return db.prepare(`SELECT rs.floor_no, rs.grind_hours, rs.watchlist, l.wallet,
      (SELECT MAX(started_at) FROM runs r WHERE r.floor_no = rs.floor_no) AS last_run_at,
      (SELECT COUNT(*) FROM runs r2 WHERE r2.floor_no = rs.floor_no AND r2.started_at > ?) AS runs_24h
    FROM room_settings rs JOIN leases l ON l.floor_no = rs.floor_no
    WHERE rs.mode = 'grind'`).all(Date.now() - 86400e3);
}

/** Has this floor already researched this mint recently? Grinding must not re-buy the question. */
export const floorJudgedRecently = (floorNo, mint, withinMs = 24 * 3600e3) =>
  !!db.prepare("SELECT 1 FROM runs WHERE floor_no=? AND mint=? AND started_at > ? LIMIT 1")
    .get(floorNo, mint, Date.now() - withinMs);

export const runsFor = (floorNo, limit = 25) =>
  db.prepare("SELECT * FROM runs WHERE floor_no=? ORDER BY id DESC LIMIT ?").all(floorNo, limit);

const freeUsed = (floorNo) =>
  db.prepare("SELECT COUNT(*) n FROM runs WHERE floor_no=? AND free_run=1").get(floorNo).n;

export const freeRunsLeft = (floorNo) => Math.max(0, FREE_RUNS_WITH_LEASE - freeUsed(floorNo));

/** One run at a time per floor: a tenant cannot queue ten and drain their own balance. */
const busy = new Set();
export const isBusy = (floorNo) => busy.has(floorNo);

export async function requestRun({ floorNo, wallet, mint }) {
  const lease = leaseFor(floorNo);
  if (!lease) return { ok: false, error: "this floor is not leased" };
  if (lease.wallet !== wallet) return { ok: false, error: "this is not your floor" };
  if (busy.has(floorNo)) return { ok: false, error: "your team is already working — one at a time" };
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(mint || ""))) return { ok: false, error: "that is not a mint address" };

  const useFree = freeRunsLeft(floorNo) > 0;
  if (!useFree && balanceOf(wallet) < RUN_PRICE_BASE_UNITS) {
    return {
      ok: false, error: "not enough $CLAUDECO for a research run",
      needBaseUnits: RUN_PRICE_BASE_UNITS.toString(), haveBaseUnits: balanceOf(wallet).toString(),
    };
  }

  // Charge before working, so a crash cannot hand out free compute. Refunded below only
  // if the run dies before any model was asked anything.
  const paid = useFree ? 0n : RUN_PRICE_BASE_UNITS;
  if (!useFree) {
    db.prepare("INSERT INTO spends (wallet, base_units, created_at) VALUES (?,?,?)")
      .run(wallet, paid.toString(), Date.now());
  }
  const run = db.prepare(`INSERT INTO runs (floor_no, wallet, mint, paid, free_run, started_at)
                          VALUES (?,?,?,?,?,?)`)
    .run(floorNo, wallet, mint, paid.toString(), useFree ? 1 : 0, Date.now());
  const runId = run.lastInsertRowid;

  busy.add(floorNo);
  // Fire and forget: the room watches the event stream rather than holding the request open.
  (async () => {
    try {
      const brain = settings(floorNo).md_brain === "grok" ? "grok" : undefined;
      const res = await runFor(floorNo, () => workup(`floor${floorNo}-${runId}`, mint,
        brain ? "tenant request \u00b7 MD thinking on Grok" : "tenant request",
        // 'floor' is deliberately NOT an opportunistic lane: the tenant already paid
        // 250,000 $CLAUDECO for this run, so it draws on the full daily cap. Throttling
        // work someone has bought is not budgeting, it is keeping the money.
        { lane: "floor", ...(brain ? { pmProvider: brain } : {}) }));
      db.prepare("UPDATE runs SET symbol=?, outcome=?, detail=?, finished_at=? WHERE id=?")
        .run(res?.symbol ?? null, res?.outcome ?? "done", res?.detail ?? null, Date.now(), runId);

      // Nothing was asked of a model, so nothing should have been charged — and a
      // FREE run must not be burned either. `screened_out` never reaches a seat any
      // more than `no_data` does; charging 250k $CLAUDECO (or silently spending an
      // included run) for work that never happened is money for nothing.
      const nothingStudied = res?.outcome === "no_data" || res?.outcome === "screened_out";
      if (nothingStudied) {
        if (useFree) {
          // Give the included run back by retiring the row from the free-run count.
          db.prepare("UPDATE runs SET free_run=0, outcome=? WHERE id=?")
            .run(res?.outcome ?? "no_data", runId);
          emit("run:refunded", { floor: floorNo, runId, reason: res?.outcome, free: true });
        } else {
          db.prepare("INSERT INTO credits (signature,dest_account,wallet,base_units,seen_at) VALUES (?,?,?,?,?)")
            .run(`refund:${runId}`, "refund", wallet, paid.toString(), Date.now());
          emit("run:refunded", { floor: floorNo, runId, reason: res?.outcome });
        }
      }
    } catch (e) {
      db.prepare("UPDATE runs SET outcome='error', detail=?, finished_at=? WHERE id=?")
        .run(String(e?.message || e), Date.now(), runId);
      if (!useFree) {
        db.prepare("INSERT INTO credits (signature,dest_account,wallet,base_units,seen_at) VALUES (?,?,?,?,?)")
          .run(`refund:${runId}`, "refund", wallet, paid.toString(), Date.now());
      }
    } finally {
      busy.delete(floorNo);
      emit("run:done", { floor: floorNo, runId });
    }
  })();

  return { ok: true, runId, charged: paid.toString(), free: useFree, freeRunsLeft: freeRunsLeft(floorNo) };
}

export function roomState(floorNo, wallet, { houseSeat = false } = {}) {
  const identity = identityFor(floorNo);
  const floorLabel = ordinal(floorNo);
  // The HQ floor has no lease row by design; for a house owner it reads as
  // their own room, under the house's name.
  const lease = leaseFor(floorNo)
    ?? (houseSeat ? { floor_no: floorNo, wallet, name: "The House Desk", base_units: "0", created_at: 0 } : null);
  return {
    identity, floorLabel,
    floorNo,
    lease,
    isMine: Boolean(houseSeat || (wallet && lease && lease.wallet === wallet)),
    settings: settings(floorNo),
    runs: runsFor(floorNo),
    busy: isBusy(floorNo),
    runPriceTokens: RUN_PRICE_TOKENS,
    runPriceBaseUnits: RUN_PRICE_BASE_UNITS.toString(),
    freeRunsLeft: lease ? freeRunsLeft(floorNo) : FREE_RUNS_WITH_LEASE,
    balanceBaseUnits: wallet ? balanceOf(wallet).toString() : "0",
    decimals: DECIMALS,
  };
}
