/**
 * WALL-ST-E DASHBOARD CONTRACT
 *
 * This module turns the local executor's outbound heartbeat and one read-only
 * public-chain balance lookup into a small UI payload. It deliberately contains no
 * command, signing, secret, RPC proxy, or cap-changing field: the website can observe
 * the tenant's machine, but it cannot operate it.
 */
import { isAddress } from "./lib/base58.js";

export const EXECUTOR_HEARTBEAT_STALE_MS = 150_000;
export const EXECUTOR_READINESS_STALE_MS = 5 * 60_000;
export const EXECUTOR_CANARY_DEFAULTS = Object.freeze({
  maxSolPerTrade: 0.005,
  rolling24hDeploySol: 0.01,
  rolling24hRealizedLossBrakeSol: 0.01,
  maxOpenPositions: 4,
});
/* Per-trade ceiling raised 0.4 -> 1 on 2026-09-12 at the owner's request. Every copy moves
   together or test-operator-max-parity.mjs fails (it reads this literal by regex, which is
   why the note sits above the object rather than inside it); the bot honours the new number
   only on a release that carries it, re-armed through the caps ceremony with the new
   figures typed. */
export const EXECUTOR_OPERATOR_MAXIMA = Object.freeze({
  maxSolPerTrade: 1,
  rolling24hDeploySol: 1000,
  rolling24hRealizedLossBrakeSol: 0.4,
  /* The executor's open-position count is a SENTINEL (strategy.mjs DEFAULTS 24 — "book
     heat and the wallet bind first") and it reports that number in every heartbeat. A
     bound of 4 here rejected every one of those heartbeats before the SOL caps were even
     read. Held to the executor's value by test-operator-max-parity.mjs. */
  maxOpenPositions: 24,
});

const finite = (value, fallback = null) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const count = (value) => Math.min(1_000_000, Math.max(0, Math.floor(finite(value, 0))));

const timestamp = (value) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
};

const publicReadiness = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const amountLamports = Number(value.amountLamports);
  return {
    ready: value.ready === true,
    lastSuccessAt: timestamp(value.lastSuccessAt),
    observedAt: timestamp(value.observedAt),
    route: value.route === "wsol-usdc" ? "wsol-usdc" : null,
    providers: Number(value.providers) === 2 ? 2 : 0,
    /* THE FIFTH COPY OF THE PER-TRADE CEILING, AND THE ONE NOBODY DECLARED.
     *
     * This was the literal 50_000_000 — 0.05 SOL — while the four declared copies
     * (poller OPERATOR_MAX, launchd-runner OPERATOR_MONEY_MAX, install.sh
     * LIVE_OPERATOR_MAX_*, EXECUTOR_OPERATOR_MAXIMA above) moved to 0.4. An executor
     * armed at the real ceiling rehearses at 400,000,000 lamports, was zeroed here, and
     * then could never satisfy readinessCoversActiveCap below, which compares for
     * EQUALITY with the active cap. The visible effect was a correctly-armed bot
     * reported as `degraded` forever. Derived from the maxima now, so raising the
     * ceiling can never strand the readiness check again. */
    amountLamports: Number.isSafeInteger(amountLamports) && amountLamports >= 1 &&
      amountLamports <= Math.floor(EXECUTOR_OPERATOR_MAXIMA.maxSolPerTrade * 1_000_000_000)
      ? amountLamports : 0,
    // Why the rehearsal did not pass, as the bot reported it. "0/2" alone sent an
    // operator to the source to find out whether the probe even existed.
    lastError: typeof value.lastError === "string" ? value.lastError.slice(0, 300) : null,
  };
};

const publicCaps = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const caps = {
    maxSolPerTrade: finite(value.maxSolPerTrade),
    rolling24hDeploySol: finite(value.dailySolCap),
    rolling24hRealizedLossBrakeSol: finite(value.dailyLossLimitSol),
    maxOpenPositions: Number(value.maxOpenPositions),
  };
  if (!(caps.maxSolPerTrade >= 0.000001 &&
      caps.maxSolPerTrade <= EXECUTOR_OPERATOR_MAXIMA.maxSolPerTrade &&
      caps.rolling24hDeploySol >= 0.000001 &&
      caps.rolling24hDeploySol >= caps.maxSolPerTrade &&
      caps.rolling24hDeploySol <= EXECUTOR_OPERATOR_MAXIMA.rolling24hDeploySol &&
      caps.rolling24hRealizedLossBrakeSol >= 0.000001 &&
      caps.rolling24hRealizedLossBrakeSol <= EXECUTOR_OPERATOR_MAXIMA.rolling24hRealizedLossBrakeSol &&
      Number.isInteger(caps.maxOpenPositions) && caps.maxOpenPositions >= 1 &&
      caps.maxOpenPositions <= EXECUTOR_OPERATOR_MAXIMA.maxOpenPositions)) return null;
  return caps;
};

/** A boolean the bot may simply never have sent. null is "it has not said", which is
 *  not the same as false and is very much not the same as true. */
const triState = (value) => value === true ? true : value === false ? false : null;

const publicHealth = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const state = ["healthy", "entries-paused", "degraded", "manual-action", "exits-blocked"]
    .includes(value.state) ? value.state : "degraded";
  return {
    state,
    entriesPaused: value.entriesPaused === true,
    hardStop: value.hardStop === true,
    // The off switch, as the BOT reports it: its effective entry state, and the flag it
    // last read from the feed. See botRunControl below for how the two are reconciled.
    entriesEnabled: triState(value.entriesEnabled),
    deskEntriesEnabled: triState(value.deskEntriesEnabled),
    blockingIntent: value.blockingIntent === true,
    blockedPositions: count(value.blockedPositions),
    manualAction: value.manualAction === true,
    exitBlocked: value.exitBlocked === true,
    feedRollback: value.feedRollback === true,
    lastTickCompletedAt: timestamp(value.lastTickCompletedAt),
    lastFeedSuccessAt: timestamp(value.lastFeedSuccessAt),
    consecutiveFeedFailures: count(value.consecutiveFeedFailures),
    consecutiveTickFailures: count(value.consecutiveTickFailures),
    executionReadiness: publicReadiness(value.executionReadiness),
    caps: publicCaps(value.caps),
    runtimeCommit: /^[0-9a-f]{7,40}$/i.test(String(value.runtimeCommit || ""))
      ? String(value.runtimeCommit).slice(0, 40).toLowerCase() : null,
    runtimeFingerprint: /^[0-9a-f]{32}$/i.test(String(value.runtimeFingerprint || ""))
      ? String(value.runtimeFingerprint).toLowerCase() : null,
  };
};

const publicHeartbeat = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const wallet = isAddress(value.wallet) ? value.wallet : null;
  const mode = value.mode === "live" || value.mode === "paper" ? value.mode : "unknown";
  const health = publicHealth(value.health);
  return {
    mode,
    wallet,
    cursor: count(value.cursor),
    open: count(value.open),
    held: Array.isArray(value.held) ? value.held.slice(0, 20).map((holding) => ({
      mint: isAddress(holding?.mint) ? holding.mint : null,
      sol: Math.max(0, finite(holding?.sol, 0)),
      openedAt: timestamp(holding?.openedAt),
      symbol: holding?.symbol == null ? null : String(holding.symbol).slice(0, 24),
      callId: count(holding?.callId) || null,
      costSol: holding?.costSol == null ? null : Math.max(0, finite(holding.costSol, 0)),
      stop: level(holding?.stop), target: level(holding?.target), high: level(holding?.high),
      holdMaxMs: level(holding?.holdMaxMs),
      deskEntryRef: level(holding?.deskEntryRef), deskStop: level(holding?.deskStop), deskTarget: level(holding?.deskTarget),
    })).filter((holding) => holding.mint) : [],
    closed: Array.isArray(value.closed) ? value.closed.slice(0, 20).map((c) => ({
      mint: isAddress(c?.mint) ? c.mint : null,
      symbol: c?.symbol == null ? null : String(c.symbol).slice(0, 24),
      callId: count(c?.callId) || null,
      closedAt: timestamp(c?.closedAt), openedAt: timestamp(c?.openedAt) || null,
      solIn: Math.max(0, finite(c?.solIn, 0)), solOut: Math.max(0, finite(c?.solOut, 0)),
      realizedSol: finite(c?.realizedSol, null),
      fraction: finite(c?.fraction, 1),
      reason: String(c?.reason ?? "").slice(0, 120), kind: String(c?.kind ?? "").slice(0, 24),
      reported: c?.reported === true,
    })).filter((c) => c.mint && c.closedAt && c.realizedSol != null) : [],
    health,
    /* Stored sanitized by the ingest route; re-bounded here because this projection is
       what the browser sees and the ingest is not the only writer of that column. */
    ledger: publicLedger(value.ledger),
    reporting: publicReporting(value.reporting),
    ts: timestamp(value.ts),
    seenAt: timestamp(value.seenAt),
  };
};

const level = (value) => { const n = finite(value, null); return n != null && n > 0 && n < 1e12 ? n : null; };

const publicLedger = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const sol = (v) => { const n = finite(v, null); return n == null || Math.abs(n) > 1_000_000 ? null : n; };
  const realizedSol = sol(value.realizedSol), deployedSol = sol(value.deployedSol);
  if (realizedSol == null || deployedSol == null) return null;
  return {
    realizedSol, deployedSol, feesSol: sol(value.feesSol) ?? 0,
    deployments: count(value.deployments), exits: count(value.exits),
    firstAt: timestamp(value.firstAt), lastAt: timestamp(value.lastAt),
    realized24hSol: sol(value.realized24hSol) ?? 0, deployed24hSol: sol(value.deployed24hSol) ?? 0,
    openSol: Math.max(0, sol(value.openSol) ?? 0),
    asOf: timestamp(value.asOf),
  };
};

const publicReporting = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    fillsOwed: count(value.fillsOwed),
    lastReportedAt: timestamp(value.lastReportedAt),
    lastError: value.lastError == null ? null : String(value.lastError).slice(0, 200),
    lastErrorAt: timestamp(value.lastErrorAt),
  };
};

const publicSettings = (settings = {}) => ({
  appetite: ["conservative", "balanced", "aggressive"].includes(settings.appetite)
    ? settings.appetite : "balanced",
  bankrollSol: Math.max(0, finite(settings.bankrollSol, 0)),
  instantDelivery: settings.instantDelivery === true,
  categories: Array.isArray(settings.categories)
    ? settings.categories.filter((value) => typeof value === "string").slice(0, 24) : [],
  launchpads: Array.isArray(settings.launchpads)
    ? settings.launchpads.filter((value) => typeof value === "string").slice(0, 24) : [],
  minLiquidityUsd: Math.max(0, finite(settings.minLiquidityUsd, 0)),
  takeProfitX: Math.max(0, finite(settings.takeProfitX, 0)),
  fixedSol: Math.max(0, finite(settings.fixedSol, 0)),
  marketCapTier: typeof settings.marketCapTier === "string"
    ? settings.marketCapTier.slice(0, 32) : "any",
  updatedAt: timestamp(settings.updatedAt),
});

const publicBalance = (wallet, result, requiredForReadinessSol = null) => {
  if (!wallet) return {
    address: null, balanceSol: null, balanceLamports: null,
    state: "not-reported", source: null, observedAt: null,
    requiredForReadinessSol: null,
  };
  const lamports = Number(result?.lamports);
  const sol = Number(result?.sol);
  const ok = result?.ok === true && Number.isSafeInteger(lamports) && lamports >= 0 &&
    Number.isFinite(sol) && sol >= 0;
  if (!ok) return {
    address: wallet, balanceSol: null, balanceLamports: null,
    state: "unavailable", source: "solana-confirmed-read", observedAt: null,
    requiredForReadinessSol,
  };
  const threshold = Number(requiredForReadinessSol);
  const state = sol === 0 ? "empty" : !(Number.isFinite(threshold) && threshold > 0)
    ? "active-caps-unavailable" : sol < threshold
      ? "below-readiness-reserve" : "ready-balance";
  return {
    address: wallet, balanceSol: sol, balanceLamports: lamports,
    state, source: "solana-confirmed-read", observedAt: timestamp(result.observedAt) || null,
    requiredForReadinessSol: Number.isFinite(threshold) && threshold > 0 ? threshold : null,
  };
};

/**
 * THE OFF/ON SWITCH, RECONCILED IN ONE PLACE.
 *
 * There are two different facts here and a page that conflates them lies to its reader:
 *
 *   REQUESTED — what the tenant last asked for on their floor. Stored on this server.
 *               It is a row in a table. It has reached nobody.
 *   ECHOED    — what the BOT last said about itself in a heartbeat: `echoedDesk` is the
 *               flag it read out of the feed, `echoedEffective` is whether it will open
 *               a new position at all right now.
 *
 * The server has no way to push the request to the bot — the bot polls — so a bot that
 * is asleep, offline, or on a machine that lost its network has heard nothing, and the
 * only honest thing to show is PENDING. `confirmed` is deliberately conjunctive: the
 * bot must be checking in AND have echoed back this exact value. A stale heartbeat that
 * happens to carry the value the tenant just asked for is evidence about the past, not
 * a confirmation, so a check-in older than the staleness window can never confirm.
 *
 * And when the two disagree the ECHO wins the display, because the echo is what is
 * actually happening to the money: a floor asking "on" whose bot reports entries
 * refused is a bot held by its own local sentinel, which this server cannot clear and
 * must not paper over.
 *
 * Pure, so the contract has a direct test (test-bot-onoff.mjs) instead of one that has
 * to drive a browser.
 */
export function botRunControl({
  requested = true,
  requestedAt = null,
  echoedDesk = null,
  echoedEffective = null,
  heartbeatSeenAt = 0,
  nowMs = Date.now(),
  staleAfterMs = EXECUTOR_HEARTBEAT_STALE_MS,
} = {}) {
  const wanted = requested !== false;
  const now = timestamp(nowMs) || Date.now();
  const seenAt = timestamp(heartbeatSeenAt);
  const connected = seenAt > 0 && now - seenAt <= Math.max(0, Number(staleAfterMs) || 0);
  const desk = triState(echoedDesk);
  const effective = triState(echoedEffective);
  const confirmed = connected && desk === wanted;
  // Unconfirmed, or confirmed by a bot that did not report an effective state: either
  // way there is no echo to show, and "pending" is the whole truth.
  const state = !confirmed || effective === null ? "pending" : effective ? "on" : "off";
  const sentence = state === "pending"
    ? (connected
      ? "Asked. Your bot applies it on its next check-in."
      : "Your bot has not checked in, so it has not heard this yet. It applies whenever it next does.")
    : state === "on"
      ? "Your bot is opening new positions."
      : wanted
        ? "Your bot is not opening new positions — its own switch, on its machine, is refusing. " +
          "Nothing on this page can clear that."
        : "Your bot is not opening new positions. It still manages and sells anything it already holds.";
  return {
    requested: wanted,
    requestedLabel: wanted ? "ON" : "OFF",
    requestedAt: timestamp(requestedAt) || null,
    confirmed,
    pending: !confirmed,
    state,
    /* THE CHIP NAMES BOTH FACTS WHILE THEY DIFFER. "ON · PENDING" says what was asked
       for AND that nothing has confirmed it — a single word could only be one of the
       two, and the one a reader would assume is the one that is not yet true. */
    chip: state === "pending" ? (wanted ? "ON · PENDING" : "OFF · PENDING") : state.toUpperCase(),
    cls: state === "on" ? "good" : state === "off" ? "warn" : "",
    sentence,
    // The button's next press. Stopping is always the safe direction, so it is offered
    // even while a turn-off is still pending.
    nextAction: wanted ? "off" : "on",
    echo: { deskEntriesEnabled: desk, entriesEnabled: effective, connected, seenAt: seenAt || null },
    /* Said in the payload, not only in a comment: this request travels by the bot
       ASKING for it. Nothing here reaches the machine. */
    delivery: "bot-polls-feed-no-push",
    meaning: "off = open no new positions; exits, marks, reconciliation and heartbeats continue",
  };
}

export function buildExecutorDashboard({
  heartbeatLog = [],
  floorNo,
  settings = {},
  heartbeat = null,
  balanceResult = null,
  nowMs = Date.now(),
} = {}) {
  const now = timestamp(nowMs) || Date.now();
  const pulse = publicHeartbeat(heartbeat);
  const ageMs = pulse?.seenAt ? Math.max(0, now - pulse.seenAt) : null;
  const connected = ageMs != null && ageMs <= EXECUTOR_HEARTBEAT_STALE_MS;
  const filters = publicSettings(settings);
  const activeCaps = pulse?.health?.caps ?? null;
  // Mirrors the no-sign readiness reserve: active trade + network-fee ceiling +
  // two-ATA rent ceiling + untouched SOL reserve. It is a display threshold only.
  const requiredForReadinessSol = activeCaps
    ? activeCaps.maxSolPerTrade + 0.0005 + 0.0042 + 0.01 : null;
  const wallet = publicBalance(pulse?.wallet ?? null, balanceResult, requiredForReadinessSol);
  const readiness = pulse?.health?.executionReadiness;
  const readinessLastSuccessAt = timestamp(readiness?.lastSuccessAt);
  const readinessObservedAt = timestamp(readiness?.observedAt);
  const readinessFresh = readinessLastSuccessAt > 0 && readinessObservedAt > 0 &&
    readinessLastSuccessAt <= now + 60_000 && readinessObservedAt <= now + 60_000 &&
    now - readinessLastSuccessAt <= EXECUTOR_READINESS_STALE_MS &&
    now - readinessObservedAt <= EXECUTOR_READINESS_STALE_MS;
  const readinessCoversActiveCap = Boolean(activeCaps && readiness &&
    readiness.amountLamports === Math.floor(activeCaps.maxSolPerTrade * 1_000_000_000));
  const executionReadinessReady = Boolean(readinessFresh && readiness?.ready === true &&
    readiness.route === "wsol-usdc" && readiness.providers === 2 && readinessCoversActiveCap);
  // The monitor treats every missing, stale, incomplete, or wrong-size live rehearsal
  // as critical. Preserve the poller's higher-severity states, but do not let the
  // human-facing status contradict that same evidence by displaying healthy/paused.
  const displayedPulse = pulse?.mode === "live" && pulse.health && !executionReadinessReady &&
    (pulse.health.state === "healthy" || pulse.health.state === "entries-paused")
    ? { ...pulse, health: { ...pulse.health, state: "degraded" } } : pulse;

  return {
    floorNo: Number(floorNo),
    telemetry: {
      source: "self-reported-by-tenant-machine",
      connected,
      // Oldest first, bounded: the WALL-ST-E tab had no history at all before this.
      history: Array.isArray(heartbeatLog) ? heartbeatLog.slice(-48).map((h) => ({
        seenAt: timestamp(h?.seenAt), mode: String(h?.mode ?? "").slice(0, 16),
        open: count(h?.open), state: h?.state == null ? null : String(h.state).slice(0, 32),
      })).filter((h) => h.seenAt) : [],
      ageMs,
      staleAfterMs: EXECUTOR_HEARTBEAT_STALE_MS,
      heartbeat: displayedPulse,
    },
    wallet,
    filters,
    /* THE OFF/ON SWITCH. The tenant's request and the bot's own echo, reconciled — see
       botRunControl. It rides on the same owner-only payload the WALL-ST-E page and the
       Overview already fetch, so neither screen has to make a second round trip to
       learn whether the bot has heard. */
    runControl: botRunControl({
      requested: settings.entriesEnabled !== false,
      requestedAt: settings.entriesEnabledAt ?? null,
      echoedDesk: pulse?.health?.deskEntriesEnabled ?? null,
      echoedEffective: pulse?.health?.entriesEnabled ?? null,
      heartbeatSeenAt: pulse?.seenAt ?? 0,
      nowMs: now,
    }),
    activation: {
      feedCredentialReady: settings.feedCredentialReady === true,
      heartbeatSeen: Boolean(pulse),
      // A stale heartbeat is historical evidence, not present-tense readiness. Keep
      // its last-reported values visible for diagnosis, but never let them complete
      // an activation step or imply that the current process still owns this wallet.
      currentPaperMode: connected && pulse?.mode === "paper",
      currentLiveMode: connected && pulse?.mode === "live",
      executionReadinessReady: connected && executionReadinessReady,
      walletReported: connected && Boolean(wallet.address),
      walletFunded: connected && Boolean(activeCaps) && wallet.state === "ready-balance",
    },
    boundary: {
      custody: "tenant-machine-only",
      remoteControl: false,
      browserSigning: false,
      balanceReadOnly: true,
    },
    /* YOUR KEY, AND WHERE IT ACTUALLY IS.
     *
     * Owner, 2026-09-07: "all floors should be able to see and use their burner private
     * key." They already can — every floor's burner is generated on that floor's own
     * machine and this server has never received one (the heartbeat carries the public
     * address and nothing else) — but nothing on the floor SAID so, and a tenant who
     * cannot find the key reasonably concludes the desk is holding it. So this block
     * names the address, says where the key lives, and gives the local commands that
     * reveal, export, verify and import it. Every field here is public or static text.
     * The secret cannot appear: it is not an input to this function and the process
     * that builds this page has no path to the file that holds it. The test asserts
     * that nothing secret-shaped can be in this block. */
    burnerKey: {
      address: wallet.address ?? null,
      heldBy: "tenant-machine-only",
      onThisServer: false,
      whereItLives: "burner.json, next to the bot, mode 600, on the machine that runs it — " +
        "this desk never receives it and cannot show it",
      howToUse: [
        { what: "public key and status (safe to run any time)", command: "node burner-backup.mjs" },
        { what: "write a 0600 recovery file", command: "node burner-backup.mjs --out <file>" },
        { what: "prove a recovery file restores THIS wallet — do it before you need it",
          command: "node burner-backup.mjs --verify <file>" },
        { what: "print the secret to your terminal", command: "node burner-backup.mjs --show --i-understand" },
      ],
      importNote: "The recovery file is base58 — the form Phantom, Solflare and Backpack accept " +
        "under \"import private key\" — so recovery needs no part of this software.",
      runFrom: "the folder the bot runs in, the one holding burner.json",
    },
    capPolicy: {
      active: activeCaps,
      activeFresh: connected && Boolean(activeCaps),
      canaryDefaults: EXECUTOR_CANARY_DEFAULTS,
      operatorMaxima: EXECUTOR_OPERATOR_MAXIMA,
      raisedCapsRequire: "local-versioned-wallet-and-values-acknowledgement",
      lossControl: "rolling-realized-loss-entry-brake-not-loss-guarantee",
    },
  };
}
