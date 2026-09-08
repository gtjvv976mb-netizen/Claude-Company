/**
 * THE IGNITION LANE — what is moving on pump.fun right now.
 *
 * The desk's research is expensive and slow by design: eleven model calls, forty cents
 * and eight minutes to judge one coin. That is the right shape for a thesis and the
 * wrong shape for a $9k coin that doubles in five minutes, and the owner asked for
 * both. So this lane does no thinking at all. It is arithmetic over free data —
 * pump.fun's own listing and its own minute candles — and its only job is to answer
 * "which of the eleven hundred coins alive this hour is actually moving", cheaply
 * enough to ask again every minute.
 *
 * What it costs: about six HTTP requests plus one minute-tape per shortlisted coin.
 * No model is called. Nothing here can spend a cent of the research budget.
 *
 * What it is NOT: a decision. Ignition ranks; the desk still decides, and every safety
 * gate downstream still runs. A coin arriving through this lane is a coin the desk has
 * been told to LOOK at sooner, not one it has been told to buy.
 */
import { CAP_BANDS } from "./categories.js";
import { asCandidate, momentumFor, newLaunches, recentlyTraded, BIRTH_TAPE_CANDLES } from "./data/pumpfun-live.js";
import { emit } from "./lib/bus.js";

/* HOW LONG A BAND IS WORTH HUNTING IN.
 *
 * A coin's hold window says how long the desk stays in; this says how long after birth
 * the desk is still interested in getting in. They are deliberately different numbers:
 * a nano coin four hours old has already had its move, whatever its market cap says,
 * and a $5m coin two days old is perfectly ordinary. The multiple is generous —
 * twelve times the hold window — because the point is to exclude the archaeology the
 * old keyword sweep was returning (median age twenty-five days), not to be clever. */
const HUNT_WINDOW_MULTIPLE = 12;
/* Exported because evidence.js asks the same question of the one coin it is gathering
   — is this still inside the window the lane hunts in — and must not carry its own copy
   of the multiple. */
export const huntWindowMs = (band) => (CAP_BANDS[band]?.holdMaxMs ?? 0) * HUNT_WINDOW_MULTIPLE;

/* WHAT THE CURVE ADDS TO ATTENTION — the one early signal the feed gives away.
 *
 * Attention was freshness*2 + replies/60 + mcap/ath, and replies are 0 on every fresh
 * row, so two coins of the same age read the same whether one had 3% of its curve
 * filled or 55%. Progress by SOL is derived per row with no constant (pumpfun-live.js
 * curveOf) and costs nothing, so it is the term: half the curve earns the whole point,
 * and past half the coin is a graduation story rather than an ignition one. Measured
 * 2026-09-08: 4 PASS + 15 WATCH in 500 workups (3.8%), and the live nano drawer held
 * coins aged 141h/25h/5h/168h/19h — nothing free was reading where on the curve they sat.
 *
 * Two more free facts, read off the same row:
 *   - a coin under half its own high, with that high set more than twenty minutes ago,
 *     is a LATE look whatever its tape does next, and loses half a point on top of the
 *     nearHigh term. A coin 60% off a 20-minute-old ATH was being refused after a ~$0.40
 *     paid workup; this refuses to look at it first, for $0;
 *   - a mini curve (~10.95 SOL to graduate, pumpfun-live.js CURVE_MINI_BELOW_SOL) fills
 *     in one buy, so it is dropped from the shortlist unless already over 80% along. */
const MIN = 60_000;
const CURVE_FULL_ATTENTION_AT = 0.5;    // the progressSol that earns the whole point
const LATE_LOOK_ATH_RATIO = 0.5;        // under half its own high...
const LATE_LOOK_ATH_AGE_MS = 20 * MIN;  // ...set more than twenty minutes ago
const LATE_LOOK_PENALTY = 0.5;
const MINI_CURVE_MIN_PROGRESS = 0.8;

/**
 * The attention one candidate earns, term by term. Pure and exported so the ruler can
 * be checked against a coin whose answer is already known before the shortlist is
 * trusted with it. `ageMs` may be handed in by a caller that has already measured it;
 * undefined means "measure it here", null means "unreadable".
 */
export function attentionOf(candidate, { now = Date.now(), ageMs } = {}) {
  const live = candidate?.live ?? {};
  const window = huntWindowMs(live.band) || 1;
  if (ageMs === undefined) {
    const createdAt = candidate?.pair?.pairCreatedAt;
    ageMs = createdAt ? now - createdAt : null;
  }
  const freshness = ageMs == null ? 0.35 : Math.max(0, 1 - ageMs / window);
  const replies = Math.min(1, (live.replyCount ?? 0) / 60);
  // A coin already well below its own high is a late look, not an early one.
  const ath = live.athMarketCap;
  const mcap = candidate?.pair?.marketCap;
  const nearHigh = ath > 0 && mcap > 0 ? Math.min(1, mcap / ath) : 0.5;
  // Where on the curve it sits. Null — a row with no readable curve, or a keyword-sweep
  // row that has no `live` at all — is simply no bonus, never a penalty.
  const curve = live.progressSol != null ? Math.min(1, live.progressSol / CURVE_FULL_ATTENTION_AT) : 0;
  const lateLook = live.athRatio != null && live.athRatio < LATE_LOOK_ATH_RATIO
    && live.athAt != null && now - live.athAt > LATE_LOOK_ATH_AGE_MS ? LATE_LOOK_PENALTY : 0;
  return { attention: freshness * 2 + replies + nearHigh + curve - lateLook,
    freshness, replies, nearHigh, curve, lateLook };
}

/** Coins whose tape is worth pulling. Free: nothing here makes a request. */
export function shortlist(candidates, { now = Date.now(), limit = 40 } = {}) {
  const eligible = [];
  for (const c of candidates) {
    const band = c?.live?.band;
    if (!band || c.live.banned) continue;
    const createdAt = c.pair?.pairCreatedAt;
    const ageMs = createdAt ? now - createdAt : null;
    // An unreadable age is not a disqualification — the desk's standing rule for a
    // number it could not measure — but it does not earn the freshness bonus either.
    if (ageMs != null && ageMs > huntWindowMs(band)) continue;
    /* A coin nobody has traded in the last ten minutes is not igniting, whatever its
       market cap. This is the cheapest possible liveness test and it removes most of
       the listing before a single tape is pulled. */
    const lastTradeAt = c.live.lastTradeAt;
    if (lastTradeAt != null && now - lastTradeAt > 10 * 60_000) continue;
    // A mini curve fills in one buy: unless it is already most of the way along there
    // is no ignition to read on it, only a lottery ticket (see the constants above).
    if (c.live.curveClass === "mini" && !(c.live.progressSol > MINI_CURVE_MIN_PROGRESS)) continue;
    eligible.push({ candidate: c, ageMs });
  }
  /* Rank for ATTENTION, not for merit: this only decides whose minute tape gets pulled,
     and the tape is what actually judges. Youth first, because the whole point of this
     lane is to be early, then the curve and the crowd signal pump.fun gives away free. */
  const scored = eligible.map(({ candidate, ageMs }) =>
    ({ candidate, ageMs, attention: attentionOf(candidate, { now, ageMs }).attention }));
  scored.sort((a, b) => b.attention - a.attention);
  return scored.slice(0, Math.max(0, limit)).map((s) => s.candidate);
}

/**
 * What the tape says. Pure, and deliberately readable as a sentence: every number that
 * moves the score is one a person can check against the chart afterwards.
 *
 * Positive score means "moving up on rising volume, not yet exhausted". A coin can
 * score well and still be a terrible trade — that is what the rest of the desk is for.
 */
/* SOL ENTERING THE CURVE, as a share of the curve per minute — capped so the term can
   lift a coin but never carry one. The funnel keeps the last two curve readings the
   sweep stored (funnel.js curveVelocity), so from a coin's second sighting on the desk
   knows how fast its curve is filling for $0. A standard curve owes 85.005 SOL
   (pumpfun-live.js curveOf), so 1 SOL a minute reads ~1.2 points and 17 SOL a minute
   hits the cap; a boosted 300-SOL curve needs proportionally more, as it should. */
const CURVE_VELOCITY_MAX_POINTS = 20;

export function ignitionScore(momentum, { band, curveVelocity = null, gradSolTotal = null } = {}) {
  if (!momentum) return null;
  const reasons = [];
  let score = 0;
  const add = (points, why) => { if (points) { score += points; reasons.push(why); } };

  const p5 = momentum.pct5m ?? 0, p15 = momentum.pct15m ?? 0, p30 = momentum.pct30m ?? 0;
  // The five-minute move is the one that matters for a thirty-minute horizon; the
  // longer windows are there to tell a fresh move from the tail of an old one.
  add(Math.max(-25, Math.min(45, p5 * 1.5)), `5m ${p5.toFixed(1)}%`);
  add(Math.max(-15, Math.min(25, p15 * 0.5)), `15m ${p15.toFixed(1)}%`);
  // A coin already up hugely over thirty minutes is not early. Mild, deliberate penalty.
  if (p30 > 120) add(-12, `already +${Math.round(p30)}% over 30m`);

  const accel = momentum.volAccel;
  if (accel != null) add(Math.max(-10, Math.min(25, (accel - 1) * 12)),
    `volume ${accel.toFixed(2)}x its prior five minutes`);
  // A silent prior window with real volume now IS the ignition case, not a missing ratio.
  else if (momentum.vol5mUsd > 0) add(14, "volume from a standing start");

  // Money actually changing hands. A 200% move on $40 of volume is a chart artefact.
  const vol = momentum.vol5mUsd ?? 0;
  add(vol >= 25_000 ? 12 : vol >= 5_000 ? 7 : vol >= 500 ? 2 : -8,
    `$${Math.round(vol).toLocaleString()} traded in five minutes`);

  const dd = momentum.drawdownFromHighPct ?? 0;
  if (dd < -35) add(-14, `${Math.round(-dd)}% off its high already`);

  /* Too short a tape is not evidence of anything — and "short" is a span, not a row
     count. This read `momentum.minutes`, which was the NUMBER OF CANDLES: a coin that
     traded in forty scattered minutes across two days scored as a mature tape, while a
     coin genuinely four minutes into its life scored the same as one four candles into
     a quiet week. The feed omits minutes nobody traded, so the two are unrelated. */
  const cover = momentum.coverageMins ?? 0;
  if (cover < 5) add(-6, `only ${cover.toFixed(0)} minutes of tape`);
  /* A LIVE FIVE-MINUTE WINDOW, OR NO CREDIT FOR ONE. If the last print is older than
     the window it is supposed to describe, vol5mUsd is a number about the past. */
  if (momentum.stalenessMins != null && momentum.stalenessMins > 5)
    add(-10, `last trade ${Math.round(momentum.stalenessMins)} minutes ago`);

  /* Only with a prior curve reading: velocity is null on a first sighting, and SOL
     LEAVING the curve is clamped to 0 rather than penalised — the drawdown term above
     already reads a sell-off, and a graduation drains the reserve in one block without
     being a sell (funnel.js). Zero points adds no reason, so a flat curve says nothing. */
  if (Number.isFinite(curveVelocity) && gradSolTotal > 0) {
    const pctPerMin = (curveVelocity / gradSolTotal) * 100;
    add(Math.max(0, Math.min(CURVE_VELOCITY_MAX_POINTS, pctPerMin)),
      `curve filling ${pctPerMin.toFixed(2)}% a minute`);
  }

  return { score: Math.round(score), reasons, band: band ?? null };
}

/**
 * One pass: read pump.fun, shortlist, pull tapes, rank.
 *
 * Returns every candidate it scored, ranked, plus the raw counts — a caller that wants
 * only the top few can slice, and the counts are what makes the lane auditable in a log.
 */
/* `curveVelocityOf(mint)` is the funnel's SOL-per-minute reading, lent by the caller
   (penthouse.js ignitionUniverse passes funnel.curveVelocity) rather than imported here:
   this module is arithmetic over free data and evidence.js imports it for huntWindowMs,
   so it must not grow a database of its own. Without it the score is exactly what it
   was; with it a coin the funnel has seen twice earns the velocity term. */
export async function ignitionSweep({ solUsd = null, freshPages = 2, tradedPages = 4,
  tapes = 40, tapeMinutes = 40, concurrency = 8, now = Date.now(), curveVelocityOf = null } = {}) {
  const [fresh, traded] = await Promise.all([
    newLaunches({ pages: freshPages }).catch(() => []),
    recentlyTraded({ pages: tradedPages }).catch(() => []),
  ]);
  const seen = new Map();
  for (const row of [...traded, ...fresh]) {
    const c = asCandidate(row, { solUsd, now });
    if (c && !seen.has(c.mint)) seen.set(c.mint, c);
  }
  const all = [...seen.values()];
  const picked = shortlist(all, { now, limit: tapes });
  /* THE BIRTH TAPE FOR THE COINS THAT STILL HAVE ONE. A nano or micro coin inside its
     hunt window is young enough that the server's 200-row ceiling usually returns its
     whole life, so row 0 is the launch minute and momentumFrom can read what that minute
     carried against the curve's opening SOL (GoatPro: $6,189 on a ~$5k curve). Every
     other shortlisted coin gets the ordinary forty-minute tape; the extra is a bigger
     response on the same free request, no new call. */
  const perMint = new Map();
  for (const c of picked) {
    const band = c.live.band;
    if (band !== "nano" && band !== "micro") continue;
    const createdAt = c.pair?.pairCreatedAt ?? null;
    const ageMs = createdAt ? now - createdAt : null;
    if (ageMs == null || ageMs < 0 || ageMs > huntWindowMs(band)) continue;
    const openSol = c.live.curveOpenSol;
    perMint.set(c.mint, { limit: BIRTH_TAPE_CANDLES, createdAt,
      curveOpenUsd: openSol > 0 && solUsd > 0 ? openSol * solUsd : null });
  }
  const momentum = await momentumFor(picked.map((c) => c.mint),
    { limit: tapeMinutes, concurrency, now, perMint });

  const ranked = [];
  for (const c of picked) {
    const mo = momentum.get(c.mint) ?? null;
    // A lookup that throws reads as no reading: the lane degrades, it never fails.
    let curveVelocity = null;
    if (curveVelocityOf) { try { curveVelocity = curveVelocityOf(c.mint) ?? null; } catch { curveVelocity = null; } }
    const scored = ignitionScore(mo, { band: c.live.band, curveVelocity, gradSolTotal: c.live.gradSolTotal });
    if (!scored) continue;
    ranked.push({ ...c, momentum: mo, ignition: scored, curveVelocity });
  }
  ranked.sort((a, b) => b.ignition.score - a.ignition.score);

  const bands = {};
  for (const c of all) if (c.live.band) bands[c.live.band] = (bands[c.live.band] || 0) + 1;
  const result = { seen: all.length, onBoard: Object.values(bands).reduce((a, b) => a + b, 0),
    shortlisted: picked.length, scored: ranked.length, bands, ranked };
  emit("ignition:sweep", { seen: result.seen, onBoard: result.onBoard, shortlisted: result.shortlisted,
    scored: result.scored, bands, top: ranked.slice(0, 5).map((r) => ({
      symbol: r.pair.baseSymbol, band: r.live.band, score: r.ignition.score,
      pct5m: r.momentum?.pct5m ?? null, mcap: r.pair.marketCap,
      curve: r.live.progressSol ?? null, athRatio: r.live.athRatio ?? null })) });
  return result;
}
