import { EXECUTOR_OPERATOR_MAXIMA } from "./executor-dashboard.js";
import db from "./lib/store.js";
import { cfg, MINTS } from "./config.js";

/**
 * THE AMOUNT THE ROUTE PROBE IS QUOTED AT — a test instrument, not a trading size.
 *
 * THE OWNER'S RULE (2026-09-07, final): the desk says only WHAT and WHEN. It never says
 * how much, and it never judges fees, costs or balance. Size belongs to the bot.
 *
 * So why does this file exist at all? Because a Jupiter quote needs an amount. The desk
 * asks one genuine coin-quality question of Jupiter — CAN THIS TOKEN BE SOLD? — and
 * there is no size-free way to ask it: you quote in, you quote back out, and you see
 * whether a route exists and returns anything. `unverified_exit` (data/evidence.js)
 * kills on the answer, because unverified is not safe.
 *
 * WHAT CHANGED ON 2026-09-07, and it is the whole point of this docstring. This file
 * used to serve the desk's stop-floor and size vetoes — edge_below_cost,
 * stop_inside_costs, size_exceeds_exit_probe, cannot_exit. All four are deleted. The
 * notional here is therefore no longer an input to ANY judgment; it is the amount
 * printed on a route test, recorded so the report can say what was quoted and the
 * floor's screen can show the tenant where the number came from. Nothing may veto on it
 * again. If a future reader is tempted to derive a cost ceiling from it: that is the
 * bug, and it cost twelve of the desk's last hundred coins.
 *
 * THE DIRECTION OF ERROR NO LONGER MATTERS, which is a relief. A route either exists or
 * it does not, and it exists at $2 and at $75 alike; only the PRICE of using it moves
 * with size, and the price is the bot's business (executor/jupiter.mjs:1341-1350
 * measures it at the bot's own amountRaw before signing). The old comment here argued
 * carefully that every degenerate case must resolve UPWARD so the stop floor stayed
 * conservative. With the stop floor gone, that argument is void — the cases still
 * resolve to a stated constant, but now only so the probe has a defined amount to quote
 * rather than to steer a veto.
 *
 * It still MEASURES the bot rather than picking a number, because that remains the
 * honest thing to quote: WALL-ST-E declares its own caps on every heartbeat
 * (poller.mjs sendHeartbeat → health.caps.maxSolPerTrade), the server stores them in
 * copy_settings.executor_heartbeat, and the largest live one is a real amount somebody
 * might really trade.
 */

/* THE STATED AMOUNT USED WHEN THERE IS NO BOT TO MEASURE.
 *
 * This was cfg.targetSizeUsd / DESK_TARGET_SIZE_USD, and it is a plain constant now,
 * env-free on purpose. As a config knob it was a size the desk chose and therefore a
 * standing invitation to reintroduce exactly the judgment that was removed — and it had
 * already been the load-bearing input to a veto that refused a coin at "$75" for a bot
 * trading "$2". Nothing downstream reads it as a limit; it exists so a quote has an
 * amount. $15 is kept from the old default, sized off the executor's 0.05 SOL hard
 * ceiling (poller.mjs OPERATOR_MAX) with headroom for SOL appreciation. */
export const ROUTE_PROBE_FALLBACK_USD = 15;

/* THE SOL PRICE, and the reason it is fenced. Read the desk's own executor fills:
 * sol_usd on an executor_fills row was written from the bot's real chain buy or sell,
 * which is the freshest honest number reachable synchronously from a deterministic
 * function. Nothing usable? cfg.solUsdFallback, a stated constant.
 *
 * The band and the age bound exist because an UNDERSTATED SOL price widens the SOL cap
 * derived from a USD notional (cap = $probe / solUsd), which is the unsafe direction: a
 * garbage 0.01 would effectively uncap it. Out-of-band or stale prices are refused,
 * never clamped — a clamped garbage price still looks like a measurement. */
export const SOL_USD_SANE_MIN = 5, SOL_USD_SANE_MAX = 10_000;
export const SOL_USD_MAX_AGE_MS = 7 * 86_400e3;

export function sizingSolUsd({ now = Date.now() } = {}) {
  let row = null;
  try {
    row = db.prepare(`SELECT sol_usd, at FROM executor_fills
      WHERE sol_usd IS NOT NULL ORDER BY at DESC LIMIT 1`).get();
  } catch { row = null; }
  const px = Number(row?.sol_usd);
  const fresh = Number.isFinite(px) && px >= SOL_USD_SANE_MIN && px <= SOL_USD_SANE_MAX &&
    Number.isFinite(Number(row?.at)) && now - Number(row.at) <= SOL_USD_MAX_AGE_MS;
  return fresh
    ? { solUsd: px, source: "the bot's last chain fill" }
    : { solUsd: Number(cfg.solUsdFallback) || 0, source: "DESK_SOL_USD_FALLBACK" };
}

/* THE BAND A DECLARED CAP MUST SIT IN. The upper bound mirrors the executor's own
 * OPERATOR_MAX.maxSolPerTrade (poller.mjs) — a bot cannot configure past 0.05 SOL
 * without a code change, so a heartbeat claiming more is either an older shape, a
 * different build, or a lie, and none of those is a measurement. office.js's
 * sanitizeExecutorHealth already enforces the same ceiling on ingest; this is the
 * second reading, because the number crosses a trust boundary and a stored row can
 * predate a sanitiser. */
export const BOT_CAP_SOL_MIN = 0.000001;
/* Derived, not pinned: this was the literal 0.05 after the executor moved to 0.4, so the
   desk's evidence probe kept sizing at 0.05 for a bot armed at 0.4. */
export const BOT_CAP_SOL_MAX = EXECUTOR_OPERATOR_MAXIMA.maxSolPerTrade;

/* HOW OLD A PULSE MAY BE AND STILL COUNT AS A MEASUREMENT. WALL-ST-E heartbeats every
 * 60 seconds, so a day of silence is a bot that is off, uninstalled or unreachable —
 * not a bot whose caps the desk should still be sizing its evidence around. A stale
 * pulse resolves to the configured default rather than to its own last-known cap,
 * because the honest statement is "no bot is telling us anything", and the default is
 * the larger, more conservative probe. */
export const HEARTBEAT_MAX_AGE_MS = 24 * 3_600e3;

/* A QUOTE TOO SMALL TO MEAN ANYTHING. Below about a dollar the USDC leg rounds hard
 * enough that a live route can fail to quote at all, which would read back as "this
 * cannot be sold" — a false honeypot. That failure mode is about the QUOTE, not about
 * cost, so it survives the removal of the cost judgments. A bot whose cap converts
 * under this is quoted at the stated amount instead. */
export const MIN_PROBE_USD = 1;

/* `probe-notional.js` USED TO SIT BESIDE THIS FILE and is deleted. It held a pure
 * read-back — `probedNotionalUsd(ev)` — so that risk-rails.js and compliance.js could
 * agree with this file's arithmetic without importing a SQLite handle. Both of those
 * call sites were size vetoes and both are gone, so the read-back had no readers left.
 * A pure helper whose only purpose is to feed a deleted veto is not neutral: it is the
 * first half of that veto, waiting. */

/** One floor's last-declared caps, or null. Parsing is defensive at every step: this
 *  row is written from a self-reported pulse by a machine the server does not own. */
export function botDeclaredCaps(floorNo, { now = Date.now() } = {}) {
  let raw = null;
  try {
    raw = db.prepare("SELECT executor_heartbeat FROM copy_settings WHERE floor_no=?")
      .get(Number(floorNo))?.executor_heartbeat ?? null;
  } catch { return null; }               // copy.js migrations have not run in this process
  return capsFromHeartbeatRow(raw, Number(floorNo), now);
}

function capsFromHeartbeatRow(raw, floorNo, now) {
  let hb = null;
  try { hb = raw ? JSON.parse(raw) : null; } catch { return null; }
  if (!hb || typeof hb !== "object") return null;
  const seenAt = Number(hb.seenAt ?? hb.ts);
  const caps = hb.health?.caps;
  const maxSolPerTrade = Number(caps?.maxSolPerTrade);
  return {
    floorNo,
    seenAt: Number.isFinite(seenAt) && seenAt > 0 ? seenAt : null,
    ageMs: Number.isFinite(seenAt) && seenAt > 0 ? now - seenAt : null,
    // `null` here is the "older bot, no caps in its shape" case, kept distinct from a
    // cap of zero so the caller can say WHICH degenerate case it hit.
    maxSolPerTrade: Number.isFinite(maxSolPerTrade) ? maxSolPerTrade : null,
    dailySolCap: Number(caps?.dailySolCap) || null,
  };
}

/* THE ASSET THE ROUTE PROBE IS QUOTED IN — WSOL when a bot is reporting, USDC otherwise.
 *
 * THE DEFECT: the probe always quoted USDC->mint->USDC, and the bot never trades that
 * pair. WALL-ST-E swaps WSOL->mint on the way in and mint->WSOL on the way out
 * (executor/jupiter.mjs WSOL, executor/poller.mjs), and it REFUSES a route that would
 * open a third wallet ATA — its rent cap is 4,200,000 lamports against 4,078,560 for
 * two accounts, so a USDC-legged route does not fit. Measured on the on-curve GoatPro:
 * one hop via Pump.fun quoted in WSOL, two hops quoted in USDC. The desk was measuring
 * a route the bot never takes, and reporting its hop count as if it were the bot's.
 *
 * WHY THE BOT'S OWN LAMPORTS AND NOT A USD CONVERSION. botProbeNotional() already reads
 * the largest per-trade cap a live bot has declared (caps.maxSolPerTrade, in SOL); it
 * then multiplies by a SOL price to state it in dollars. When a bot IS reporting, that
 * conversion is a round trip through a price the quote does not need — the honest amount
 * is the lamport figure the bot itself would send. With no bot reporting there is no
 * SOL figure to send, so the stated USD constant is quoted in USDC exactly as before.
 *
 * STILL NOT A SIZE JUDGMENT. This picks the ASSET and the AMOUNT of a test quote and
 * nothing else; no veto reads either. See the docstring at the top of this file. */
export function routeProbeLeg(probeSize) {
  const botSol = Number(probeSize?.botSol);
  if (probeSize?.fromBot === true && Number.isFinite(botSol) && botSol > 0) {
    return {
      quoteMint: MINTS.SOL, quoteAsset: "WSOL",
      // Lamports, the unit a Solana swap is actually denominated in.
      quoteAmountRaw: String(Math.round(botSol * 1e9)),
      quoteAmountUi: botSol,
    };
  }
  return {
    quoteMint: MINTS.USDC, quoteAsset: "USDC",
    quoteAmountRaw: String(Math.round(Number(probeSize?.sizeUsd ?? ROUTE_PROBE_FALLBACK_USD) * 1e6)),
    quoteAmountUi: Number(probeSize?.sizeUsd ?? ROUTE_PROBE_FALLBACK_USD),
  };
}

/**
 * THE AMOUNT THE ROUTE PROBE QUOTES — measured off the bot, never chosen by the desk,
 * and never a limit on anything.
 *
 * Pass a floorNo to ask about one floor's bot. Pass nothing (the cycle's case: one route
 * test per candidate, shared by every floor) and the answer is the LARGEST cap any live
 * bot has declared, simply because it is the most representative real amount available.
 * Nothing turns on the choice any more — the route test's verdict is "did it quote",
 * and a route that exists at one size exists at another.
 *
 * Returns a resolution that always names its own provenance, so the floor page and the
 * report can say where the number came from rather than asserting it.
 */
export function botProbeNotional({ floorNo = null, now = Date.now() } = {}) {
  const { solUsd, source: solUsdSource } = sizingSolUsd({ now });
  const fallbackUsd = ROUTE_PROBE_FALLBACK_USD;
  const fall = (why) => ({
    sizeUsd: fallbackUsd, fromBot: false, why,
    source: `the stated route-probe amount ($${fallbackUsd}) — ${why}`,
    botSol: null, botFloorNo: null, botSeenAt: null, botAgeMs: null,
    solUsd, solUsdSource, botsSeen: 0,
  });

  if (!(solUsd > 0)) return fall("no usable SOL price to convert a SOL cap with");

  let rows = [];
  try {
    rows = floorNo == null
      ? db.prepare("SELECT floor_no, executor_heartbeat FROM copy_settings WHERE executor_heartbeat IS NOT NULL").all()
      : db.prepare("SELECT floor_no, executor_heartbeat FROM copy_settings WHERE floor_no=? AND executor_heartbeat IS NOT NULL").all(Number(floorNo));
  } catch {
    // The table is absent — this process never imported copy.js, or the schema predates
    // it. Not an error worth throwing on a sizing read; it is simply no evidence.
    return fall("the desk has no executor_heartbeat table in this process");
  }

  const parsed = rows.map((r) => capsFromHeartbeatRow(r.executor_heartbeat, Number(r.floor_no), now))
    .filter(Boolean);
  if (!parsed.length)
    return fall(floorNo == null
      ? "no bot has ever reported to this desk"
      : `floor ${floorNo} has no bot heartbeat on file`);

  const fresh = parsed.filter((p) => p.ageMs != null && p.ageMs <= HEARTBEAT_MAX_AGE_MS);
  if (!fresh.length) {
    const newest = parsed.reduce((a, b) => (a.ageMs ?? Infinity) <= (b.ageMs ?? Infinity) ? a : b);
    const hours = newest.ageMs == null ? null : Math.round(newest.ageMs / 3_600e3);
    return fall(hours == null
      ? "the last heartbeat carries no timestamp"
      : `the last heartbeat is ${hours}h old (a live bot pulses every minute)`);
  }

  const declared = fresh.filter((p) => Number.isFinite(p.maxSolPerTrade) &&
    p.maxSolPerTrade >= BOT_CAP_SOL_MIN && p.maxSolPerTrade <= BOT_CAP_SOL_MAX);
  if (!declared.length)
    return fall(`${fresh.length} live bot${fresh.length === 1 ? " reports" : "s report"} no usable ` +
      `caps.maxSolPerTrade (an older build, or a value outside ${BOT_CAP_SOL_MIN}–${BOT_CAP_SOL_MAX} SOL)`);

  // The biggest order any live bot can place. See the docstring: the probe must cover
  // the largest, not the average and not the nearest.
  const top = declared.reduce((a, b) => a.maxSolPerTrade >= b.maxSolPerTrade ? a : b);
  const sizeUsd = Number((top.maxSolPerTrade * solUsd).toFixed(2));
  if (!(sizeUsd >= MIN_PROBE_USD))
    return fall(`floor ${top.floorNo}'s bot caps a trade at ${top.maxSolPerTrade} SOL, about ` +
      `$${sizeUsd.toFixed(2)} — under the $${MIN_PROBE_USD} at which a round-trip quote still ` +
      `measures the pool rather than the rounding`);

  const bots = declared.length;
  return {
    sizeUsd, fromBot: true,
    why: `floor ${top.floorNo}'s bot caps one trade at ${top.maxSolPerTrade} SOL` +
      (bots > 1 ? ` — the largest of ${bots} live bots` : ""),
    source: `WALL-ST-E's own heartbeat: floor ${top.floorNo} caps a trade at ` +
      `${top.maxSolPerTrade} SOL, $${sizeUsd.toFixed(2)} at SOL $${solUsd} (${solUsdSource})`,
    botSol: top.maxSolPerTrade, botFloorNo: top.floorNo,
    botSeenAt: top.seenAt, botAgeMs: top.ageMs,
    solUsd, solUsdSource, botsSeen: bots,
  };
}
