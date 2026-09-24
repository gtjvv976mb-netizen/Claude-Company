/**
 * THE SECOND VENUE: NEW POOLS THAT PAIR A TOKEN WITH AN xSTOCK, TRADED THROUGH JUPITER.
 *
 * Off by default (config.xstockVenue). On, it follows the lane: Off does nothing; Observe
 * polls the new-pool feeds, runs every pool it finds through the gates below and keeps a
 * would-have position for the ones that clear; Execute, armed, buys the ones that still
 * mark at or above their would-have fill after the wait — the pump.fun lane's own entry
 * rule — and sells them on the same exit determiner. Nothing here signs, simulates or
 * reads a fill on its own: the engine hands over its own `simulateGuard`,
 * `signSendConfirm` (which refuses signed bytes whose message is not the one asked for)
 * and the tx.mjs fill reader, so a Jupiter trade passes through exactly the fences a
 * pump.fun trade does, plus the ones Jupiter needs.
 *
 * WHAT IT PAYS WITH. The pool's own stock, from the stock already in the wallet, at that
 * stock's listed numbers (config.quoteMints: ticket, canary, day cap) — the same numbers
 * and the same day ledger the pump.fun stock lane uses. The route is DIRECT: Jupiter is
 * asked for onlyDirectRoutes, so the swap goes stock → token on a pool that pairs them and
 * nothing else touches the wallet. The network fee and the token account's rent are SOL,
 * charged to the SOL day; on autopilot the wallet's SOL balance must cover them too.
 *
 * THE GATES, cheapest first; the first that fails names the refusal (XSTOCK_GATES):
 *   0 in-process   lane_off, no_rpc, hard_stop, pause_entries, no_new_token (the other side is
 *                  SOL, a dollar stablecoin or another stock), left_to_pumpfun_lane (a pump.fun
 *                  bonding curve: that lane hears it from the program's logs and has its own
 *                  gates), notice_stale (the pool's age at first sight, or since first sight at
 *                  the live attempt), already_holding (either book), already_attempted,
 *                  stock_not_listed (no ticket: the built-in list only watches),
 *                  stock_canary_blocked
 *   1 one read     mint_refused — the executor's auditMintAccount on the NEW token (plus the
 *                  two kills snipe-entry adds: a live mint or freeze authority) and NEVER on
 *                  the xStock, whose permanent delegate, freeze authority and pause switch the
 *                  audit rightly refuses; stock_unpayable — describeMint of the stock (paused,
 *                  a live transfer hook, a symbol that is not the listed one), and the ticket
 *                  through the executor's quoteTicketFor; daily_capacity (the stock's day),
 *                  daily_capacity_sol (the fee and rent on the SOL day); network_fee_over_cap
 *                  and rent_over_cap through the executor's assertNetworkFeeBudget
 *   2 Jupiter      jupiter_unavailable (rate-limited or unreachable at a live attempt; at first
 *                  sight the pool waits for a slot instead), no_route (Jupiter cannot price it), quote_mismatch, route_not_direct,
 *                  impact_over_cap, no_exit_route (cannot price the way back), round_trip_over_cap
 *   4 live only    quote_balance_short, autopilot_balance_short, transaction_refused (the
 *                  decoded transaction is not the swap asked for), simulation_refused
 *
 * THE CANARY, PER STOCK, FOR THIS VENUE. The pump.fun lane's canary proves its own buy_v2
 * account order; this venue's first live buy in a stock proves a different path (Jupiter's
 * transaction, this check, this fill reader), so it has its own: the first live buy in each
 * stock here is at that stock's minPerTrade, the full ticket only after one fill has been
 * read back, and a buy that lands but cannot be read back or booked blocks the stock in
 * this venue until the user clears it.
 *
 * Positions live in their own book (S.xstock.snipes, the executor's snipe-book shape)
 * whose "desk" side is the pump.fun book, so the book itself refuses one mint in both.
 */
import { auditMintAccount, describeMint } from "../../vendor/executor/token2022.mjs";
import { quoteTicketFor } from "../../vendor/executor/snipe-entry.mjs";
import { assertNetworkFeeBudget } from "../../vendor/executor/network-fee-budget.mjs";
import { SNIPE_LANE_DEFAULTS } from "../../vendor/executor/snipe-lane.mjs";
import { openSnipe, updateSnipe, closeSnipe, snipeList, snipeFor } from "../../vendor/executor/snipe-book.mjs";
import { quoteEntryFor, xstockFocusList, feeModelFor, autopilotBuyNeedLamports, XSTOCK_UNMEASURED } from "./config.mjs";
import { createPoolDiscovery } from "./xstock-discovery.mjs";
import {
  createJupiterClient, checkQuote, checkSwapTransaction, loadLookupTables, lookupTableKeysOf, checkWritableCustody, checkSafeAfter,
  JupiterError, SwapCheckError,
} from "./jupiter-swap.mjs";
import { associatedTokenAddress, fillFromTransaction, unitsToRaw, rawToUnits, WSOL } from "./tx.mjs";
import { SIGN_ERRORS } from "./protocol.mjs";

export const XSTOCK_VENUE_ID = "jupiter-xstock";
export const XSTOCK_GATES = Object.freeze([
  "lane_off", "no_rpc", "hard_stop", "pause_entries", "no_new_token", "left_to_pumpfun_lane", "notice_stale",
  "already_holding", "already_attempted", "stock_not_listed", "stock_canary_blocked",
  "mint_refused", "stock_unpayable", "daily_capacity", "daily_capacity_sol", "network_fee_over_cap", "rent_over_cap",
  "jupiter_unavailable", "no_route", "quote_mismatch", "route_not_direct", "impact_over_cap", "no_exit_route", "round_trip_over_cap",
  "quote_balance_short", "autopilot_balance_short", "transaction_refused", "simulation_refused",
]);
export const XSTOCK_CANARY_RULE = "In this venue, too, the first live buy in each listed stock is sized at its minPerTrade (a canary), " +
  "and the full ticket is used only after one of its Jupiter fills has been read back off the chain. " +
  "A buy that lands but cannot be read back or booked blocks that stock in this venue until you clear it in the popup.";
/** How long after first sight a live attempt may still be made: the wait, plus the marks
 *  that measure the follow-through at 0.5 Jupiter requests a second. */
export const XSTOCK_LIVE_NOTICE_SLACK_MS = 60_000;
const ATTEMPT_WINDOW_MS = 10 * 60_000;
const CANDIDATES_KEPT = 60;
const LAMPORTS = 1_000_000_000n;

export function freshXstockState() {
  return {
    snipes: {},        // this venue's book, snipe-book.mjs's shape, keyed by token mint
    canary: {},        // stock mint → { state: "proven" | "blocked", at, signature, detail }
    candidates: [],    // newest first: every pool discovery handed over, with its source, its age and what became of it
    pending: [],       // candidates waiting for a Jupiter request slot
    attempts: {},      // token mint → { at, outcome, detail }
    lastPollAt: 0,
    counters: { polls: 0, candidates: 0, refused: 0, wouldHave: 0, unsampled: 0, waitedOut: 0, liveAttempts: 0, entered: 0, sold: 0, txRefused: 0, entryFailures: 0, sellFailures: 0, marksSkipped: 0 },
  };
}

const sol = (lamports) => Number(BigInt(lamports)) / Number(LAMPORTS);
const short = (m) => (typeof m === "string" && m.length > 12 ? `${m.slice(0, 4)}…${m.slice(-4)}` : String(m));
const units = (raw, decimals, symbol) => `${rawToUnits(raw, decimals)} ${symbol}`;
const ageText = (ms) => { if (!Number.isFinite(ms)) return "an unknown time"; const s = Math.round(ms / 1000); return s < 120 ? `${s}s` : s < 7200 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`; };
const ratioX = (num, den) => (den > 0n ? Number((num * 1_000_000n) / den) / 1_000_000 : null);
/** pump.fun's bonding curve, by the name each feed gives it (GeckoTerminal "pump-fun",
 *  DexScreener "pumpfun", Jupiter's "pumpfun"). Its graduated AMM ("pumpswap",
 *  "pumpfun-amm") is an ordinary pool here. */
export const isPumpfunCurve = (dex) => typeof dex === "string" && /^pump[-.]?fun(\b|$)(?!-amm)/i.test(dex.trim());
const moneyName = (mint) => (mint === WSOL ? "SOL" : mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" ? "USDC" : mint === "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" ? "USDT" : short(mint));

/**
 * `host` is the engine: its clock, its log, its state, its config, its RPC, its signers,
 * its day ledger, its simulate guard and its sign-send-confirm. See engine.mjs where it
 * is built; nothing here reaches around it.
 */
export function createXstockLane(host) {
  const X = () => host.state().xstock;
  const xbook = () => ({ snipes: X().snipes, positions: host.state().snipes });   // the pump.fun book is this book's "desk": one mint, one position
  const sleep = (ms) => host.sleep(ms);
  const jupiter = host.jupiter ?? createJupiterClient({ fetchImpl: host.fetchImpl, clock: host.clock, sleep, timers: host.timers });
  const discovery = host.discovery ?? createPoolDiscovery({
    fetchImpl: host.fetchImpl, clock: host.clock, timers: host.timers,
    sources: () => host.config().xstockSources ?? [], focus: () => xstockFocusList(host.config()),
    horizonMs: () => Math.max(600_000, 2 * Number(host.config().xstockMaxPoolAgeMs)),
  });
  let ticking = false;
  const sellInFlight = new Set();
  const say = (line) => host.say(`xStock venue: ${line}`);

  /* ── small book helpers ─────────────────────────────────────────────────────────── */
  const rows = () => snipeList(xbook());
  const liveRows = () => rows().filter((p) => p.live === true);
  const holds = (mint) => Boolean(snipeFor(xbook(), mint)) || host.pumpfunHolds(mint);
  function attemptedRecently(mint, now) {
    const a = X().attempts[mint];
    if (!a) return false;
    if (now - a.at >= ATTEMPT_WINDOW_MS) { delete X().attempts[mint]; return false; }
    return true;
  }
  function candidateFor(pool) { return X().candidates.find((c) => c.pool === pool) ?? null; }
  function mark(pool, patch) { const c = candidateFor(pool); if (c) Object.assign(c, patch, { at: host.clock() }); }

  /* ── the gates ──────────────────────────────────────────────────────────────────── */
  /**
   * One evaluation of one pool. `mode` "first" at first sight (priority "entry" for
   * Jupiter), "live" at the attempt after the wait (priority "live"). Returns
   * { ok: true, … } or { ok: false, gate, message } or { ok: false, deferred: true } when
   * Jupiter had no request slot (the pool is not refused; it is tried again).
   */
  async function evaluate({ c, mode, pos = null }) {
    const cfg = host.config();
    const now = host.clock();
    const k = c.classification;
    const token = k.tokenMint, stock = k.stockMint;
    const fail = (gate, message, extra = {}) => ({ ok: false, gate, message, ...extra });
    const priority = mode === "live" ? "live" : "entry";

    /* cost 0 */
    if (cfg.lane === "off" || cfg.xstockVenue !== true) return fail("lane_off", "the lane or the xStock venue is off");
    const rpc = host.rpc();
    if (!rpc) return fail("no_rpc", "no RPC is configured: the token and the stock cannot be read");
    const ctl = host.control();
    if (ctl.hardStop) return fail("hard_stop", "HARD STOP is on: nothing new is opened");
    if (ctl.pauseEntries) return fail("pause_entries", "entries are paused");
    if (k.kind === "money_pair") return fail("no_new_token", `${k.stockSymbol} against ${moneyName(token)} is a market in the stock: there is no new token in it to buy`);
    if (k.kind === "stock_pair") return fail("no_new_token", `both sides are stocks (${k.stockSymbol} and ${k.tokenSymbol ?? short(token)}): there is no new token in it to buy`);
    if (isPumpfunCurve(c.dex)) return fail("left_to_pumpfun_lane", `a pump.fun bonding curve (${c.dex}): the pump.fun lane hears these from the program's own logs and judges them with its own gates and canary; this venue leaves them to it`);
    if (mode === "first") {
      if (c.createdAtMs === null || c.createdAtMs === undefined) return fail("notice_stale", "the feed gave no creation time for this pool, so it cannot be dated — an undated pool is not a launch this lane may judge");
      const age = c.firstSeenAt - c.createdAtMs;
      if (age < -60_000) return fail("notice_stale", `the pool is stamped ${ageText(-age)} in the future — a clock disagreement, not a launch`);
      if (age > Number(cfg.xstockMaxPoolAgeMs)) return fail("notice_stale", `first seen ${ageText(age)} after it was created, against a ${ageText(Number(cfg.xstockMaxPoolAgeMs))} bound`);
      if (holds(token)) return fail("already_holding", `${short(token)} is already held or watched in a book`);
      if (attemptedRecently(token, now)) return fail("already_attempted", `${short(token)} was already judged in the last ${ageText(ATTEMPT_WINDOW_MS)}`);
    } else {
      const since = now - Number(pos.noticeAt);
      const bound = Number(cfg.entryWaitMs) + XSTOCK_LIVE_NOTICE_SLACK_MS;
      if (since > bound) return fail("notice_stale", `${ageText(since)} since this pool was first seen, against the ${ageText(bound)} a live attempt may come after it`);
    }
    const entry = quoteEntryFor(cfg, stock);
    if (!entry) return fail("stock_not_listed", `${k.stockSymbol} is not listed in Options → Stock quotes, so this venue has no ticket in it (the built-in list is for watching only). List it with your own numbers to trade it`);
    const canaryState = X().canary[stock]?.state ?? "canary";
    if (canaryState === "blocked") {
      const b = X().canary[stock];
      return fail("stock_canary_blocked", `an earlier ${entry.symbol} buy in this venue (${b.signature ?? "no signature"}) landed but ${b.detail} — no further ${entry.symbol} buys here until you check it and clear the block in the popup`);
    }
    const canary = canaryState !== "proven";

    /* cost 1: one read, the new token and the stock */
    let read;
    try { read = await rpc.getMultipleAccounts([token, stock]); }
    catch (error) { return fail("mint_refused", `the token and stock accounts could not be read: ${error?.message ?? error}`); }
    let audit;
    try { audit = auditMintAccount(read.accounts?.[0] ?? null, token); }
    catch (error) { return fail("mint_refused", error.message, { source: "auditMintAccount" }); }
    if (audit.mintAuthority) return fail("mint_refused", `mint authority ${audit.mintAuthority} is live — supply can still be inflated`, { flag: "mint_authority_live" });
    if (audit.freezeAuthority) return fail("mint_refused", `freeze authority ${audit.freezeAuthority} is live — token accounts can be frozen, preventing sells`, { flag: "freeze_authority_live" });
    let facts;
    try { facts = describeMint(read.accounts?.[1] ?? null, stock); }
    catch (error) { return fail("stock_unpayable", `the ${entry.symbol} mint could not be described: ${error.message}`); }
    if (facts.metadataSymbol && facts.metadataSymbol !== entry.symbol) return fail("stock_unpayable", `the list names ${short(stock)} ${entry.symbol}, but that mint calls itself ${facts.metadataSymbol} — check the address in Options`);
    if (facts.initialized !== true) return fail("stock_unpayable", `the ${entry.symbol} mint is not initialized`);
    if (facts.transferHookProgram) return fail("stock_unpayable", `the ${entry.symbol} mint's transfer hook points at ${facts.transferHookProgram} — every transfer would run it; refused`);
    let ticket;
    try {
      ticket = quoteTicketFor({
        mint: stock, decimals: facts.decimals, tokenProgram: facts.program, symbol: entry.symbol, paused: facts.paused,
        transferHookProgram: facts.transferHookProgram,
        ticketRaw: unitsToRaw(canary ? entry.minPerTrade : entry.maxPerTrade, facts.decimals, `the ${entry.symbol} ticket`),
        minTicketRaw: unitsToRaw(entry.minPerTrade, facts.decimals, `the ${entry.symbol} minimum`),
        dailyCapRaw: unitsToRaw(entry.dailyCap, facts.decimals, `the ${entry.symbol} day cap`),
        deployedTodayRaw: host.deployedTodayQuoteRaw(stock, now),
      });
    } catch (error) { return fail("stock_unpayable", error.message); }
    if (ticket.paused) return fail("stock_unpayable", `${entry.symbol} is PAUSED by its issuer: no transfer of it can settle, so neither leg could`, { paused: true });
    if (ticket.deployedTodayRaw + ticket.ticketRaw > ticket.dailyCapRaw)
      return fail("daily_capacity", `this ${units(ticket.ticketRaw, ticket.decimals, entry.symbol)} ticket would take the ${entry.symbol} day to ${units(ticket.deployedTodayRaw + ticket.ticketRaw, ticket.decimals, entry.symbol)} against a ${entry.dailyCap} ${entry.symbol} cap`);
    /* The new token's account is created on the buy; the stock's account exists (the wallet
       holds the stock it pays with) and is created idempotently on the sell if it was closed. */
    const fees = feeModelFor(cfg, { quoteAtaCreate: false });
    const solCost = BigInt(fees.signatureFeeLamports) + BigInt(fees.prioritizationFeeLamports) + BigInt(fees.rentFeeLamports);
    const deployedSol = host.deployedTodaySol(now);
    if (deployedSol + sol(solCost) > Number(cfg.dailySolCap) + 1e-12)
      return fail("daily_capacity_sol", `this buy pays up to ${sol(solCost).toFixed(6)} SOL of network fee and rent, which would take the SOL day to ${(deployedSol + sol(solCost)).toFixed(6)} against a ${cfg.dailySolCap} SOL cap`);
    const laneCfg = host.laneCfg();
    try { assertNetworkFeeBudget({ signatureFeeLamports: fees.signatureFeeLamports, prioritizationFeeLamports: fees.prioritizationFeeLamports, rentFeeLamports: 0, feeBasisLamports: null, cfg: laneCfg }); }
    catch (error) { return fail("network_fee_over_cap", error.message); }
    try { assertNetworkFeeBudget({ signatureFeeLamports: fees.signatureFeeLamports, prioritizationFeeLamports: fees.prioritizationFeeLamports, rentFeeLamports: fees.rentFeeLamports, feeBasisLamports: null, cfg: laneCfg }); }
    catch (error) { return fail("rent_over_cap", error.message); }

    /* cost 2: Jupiter — can it price the way in, and the way back out? */
    const slip = Number(cfg.xstockSlippageBps);
    const quoteGate = (error, which) => {
      if (error instanceof JupiterError) {
        if (error.code === "rate_budget" || error.code === "rate_limited" || error.code === "network")
          return { ok: false, deferred: true, gate: "rate_budget", message: `Jupiter: ${error.message}` };
        if (error.code === "no_route") return fail(which === "in" ? "no_route" : "no_exit_route", `Jupiter cannot price ${which === "in" ? `${entry.symbol} → ${short(token)}` : `the way back, ${short(token)} → ${entry.symbol}`} on a direct route: ${error.message}`);
        return fail(which === "in" ? "no_route" : "no_exit_route", `Jupiter did not quote ${which === "in" ? "the buy" : "the way back"}: ${error.message}`);
      }
      if (error instanceof SwapCheckError) {
        const gate = ["impact_over_cap", "route_not_direct"].includes(error.clause) ? error.clause : "quote_mismatch";
        return fail(which === "out" && gate === "route_not_direct" ? "no_exit_route" : gate, `${which === "in" ? "the buy quote" : "the exit quote"}: ${error.message}`);
      }
      return fail(which === "in" ? "no_route" : "no_exit_route", String(error?.message ?? error));
    };
    let buy;
    try {
      const raw = await jupiter.quote({ inputMint: stock, outputMint: token, amountRaw: ticket.ticketRaw, slippageBps: slip, priority });
      buy = { raw, ...checkQuote(raw, { inputMint: stock, outputMint: token, amountRaw: ticket.ticketRaw, slippageBps: slip, slippageCapBps: slip, maxPriceImpactPct: cfg.maxPriceImpactPct }) };
    } catch (error) { return quoteGate(error, "in"); }
    let exit;
    try {
      const raw = await jupiter.quote({ inputMint: token, outputMint: stock, amountRaw: buy.outRaw, slippageBps: slip, priority });
      /* The exit's impact is not capped here: the round trip below is the judgement, and
         a stop must never be un-fireable for an impact figure. */
      exit = { raw, ...checkQuote(raw, { inputMint: token, outputMint: stock, amountRaw: buy.outRaw, slippageBps: slip, slippageCapBps: slip, maxPriceImpactPct: 100 }) };
    } catch (error) { return quoteGate(error, "out"); }
    const roundTripX = ratioX(exit.outRaw, ticket.ticketRaw);
    const lossPct = (1 - roundTripX) * 100;
    if (lossPct > Number(cfg.maxEntryRoundTripLossPct))
      return fail("round_trip_over_cap", `buying ${units(ticket.ticketRaw, ticket.decimals, entry.symbol)} and selling straight back returns ${units(exit.outRaw, ticket.decimals, entry.symbol)}: a ${lossPct.toFixed(2)}% loss against the ${cfg.maxEntryRoundTripLossPct}% cap`);
    return { ok: true, entry, facts, audit, ticket, canary, buy, exit, roundTripX, fees, solCost, tokenProgram: audit.program, stockProgram: facts.program };
  }

  /* ── a pool the feeds handed over ───────────────────────────────────────────────── */
  function candidateRow(c) {
    const k = c.classification;
    return {
      pool: c.pool, dex: c.dex, name: c.name ?? null, sources: [...c.sources], kind: k.kind,
      stockMint: k.stockMint, stockSymbol: k.stockSymbol, stockListed: k.stockListed, stockSide: k.stockSide,
      tokenMint: k.tokenMint, tokenSymbol: k.tokenSymbol, createdAtMs: c.createdAtMs, firstSeenAt: c.firstSeenAt,
      ageAtFirstSightMs: c.ageAtFirstSightMs, liquidityUsd: c.liquidityUsd ?? null,
      state: "new", gate: null, message: null, at: host.clock(),
    };
  }

  async function judge(c) {
    const now = host.clock();
    const k = c.classification;
    const v = await evaluate({ c, mode: "first" });
    if (v.deferred) {
      mark(c.pool, { state: "pending", gate: null, message: `waiting for a Jupiter request slot (${v.message})` });
      if (!X().pending.some((p) => p.pool === c.pool)) X().pending.push(c);
      return v;
    }
    X().pending = X().pending.filter((p) => p.pool !== c.pool);
    if (!v.ok) {
      X().counters.refused++;
      X().attempts[k.tokenMint] = { at: now, outcome: "refused", detail: v.gate };
      mark(c.pool, { state: "refused", gate: v.gate, message: v.message });
      say(`${k.tokenSymbol ?? short(k.tokenMint)} / ${k.stockSymbol} (${c.dex ?? "?"}, from ${c.sources.join("+")}): refused at ${v.gate} — ${v.message}`);
      host.persist();
      return v;
    }
    const openPaper = rows().filter((p) => p.live !== true).length;
    if (openPaper >= Number(host.config().xstockMaxOpen)) {
      X().counters.unsampled++;
      X().attempts[k.tokenMint] = { at: now, outcome: "unsampled", detail: `${openPaper} would-have rows already marked` };
      mark(c.pool, { state: "unsampled", gate: null, message: `cleared every gate; not marked — ${openPaper} would-have rows already use the Jupiter budget` });
      host.persist();
      return v;
    }
    return openWouldHave(c, v, now);
  }

  function openWouldHave(c, v, now) {
    const k = c.classification;
    const t = v.ticket;
    const sizeSol = Number(rawToUnits(t.ticketRaw, t.decimals));
    try {
      const position = host.determiner.open({ mint: k.tokenMint, entry: 1, openedAt: now, creator: null, sizeSol, feeSolPerLeg: 0 });
      openSnipe(xbook(), {
        ...position, mint: k.tokenMint, venue: XSTOCK_VENUE_ID, entry: 1, openedAt: now, sizeSol, feeSolPerLeg: 0,
        qtyRaw: v.buy.outRaw.toString(), entryInputLamports: t.ticketRaw.toString(), entryFeeLamports: "0",
        quoteMint: t.mint, quoteDecimals: t.decimals, quoteSymbol: t.symbol, quoteTokenProgram: v.stockProgram,
        networkFeeLamports: v.solCost.toString(), costBasisQuoteRaw: t.ticketRaw.toString(),
        baseTokenProgram: v.tokenProgram, pool: c.pool, dex: c.dex, sources: [...c.sources], poolCreatedAtMs: c.createdAtMs,
        noticeAt: c.firstSeenAt, creator: null, frictionXAtOpen: 1, samples: 0, live: false, liveAttempted: false,
        lastMarkX: v.roundTripX, lastTickAt: now, name: c.name ?? null, symbol: k.tokenSymbol ?? null, canaryTicket: v.canary,
        firstImpactPct: v.buy.impactPct, firstRoundTripX: v.roundTripX,
      });
    } catch (error) {
      mark(c.pool, { state: "refused", gate: "book", message: `the book refused the would-have row: ${error.message}` });
      say(`${short(k.tokenMint)}: the book refused the would-have row (${error.clause ?? error.name}): ${error.message}`);
      host.persist();
      return { ok: false, gate: "book", message: error.message };
    }
    X().counters.wouldHave++;
    X().attempts[k.tokenMint] = { at: now, outcome: "watching", detail: "would have entered; watching" };
    mark(c.pool, { state: "watching", gate: null, message: `cleared — would have paid ${units(t.ticketRaw, t.decimals, t.symbol)}${v.canary ? " (the canary)" : ""} for ${v.buy.outRaw} base; an immediate round trip marks ${v.roundTripX.toFixed(3)}x` });
    say(`${k.tokenSymbol ?? short(k.tokenMint)} / ${t.symbol} (${c.dex ?? "?"}): cleared — would have paid ${units(t.ticketRaw, t.decimals, t.symbol)}, marks ${v.roundTripX.toFixed(3)}x at once; ${host.armed() ? `watching ${Math.round(Number(host.config().entryWaitMs) / 1000)}s before ${host.onAutopilot() ? "the autopilot wallet signs" : "asking Phantom"}` : "watching"}`);
    host.persist();
    return { ...v, opened: true };
  }

  /* ── the check before anything is signed ────────────────────────────────────────── */
  /** Jupiter's transaction, decoded and bound (jupiter-swap.mjs), then the wallet's other
   *  token accounts proved untouched, then the engine's own simulate guard on the two it
   *  trades through, then the exact input and the custody of both after the simulation. */
  async function checkBeforeSigning({ txBase64, wallet, side, stock, token, stockProgram, tokenProgram, amountRaw, quote, minOutRaw, decimals, symbol }) {
    const cfg = host.config();
    const rpc = host.rpc();
    const inputMint = side === "buy" ? stock : token, outputMint = side === "buy" ? token : stock;
    const inputProgram = side === "buy" ? stockProgram : tokenProgram, outputProgram = side === "buy" ? tokenProgram : stockProgram;
    const tables = await loadLookupTables(rpc, lookupTableKeysOf(txBase64));
    const checked = checkSwapTransaction({
      txBase64, wallet, inputMint, outputMint, inputProgram, outputProgram, amountRaw, quote,
      slippageCapBps: Number(cfg.xstockSlippageBps), lookupTables: tables, maxPriorityFeeLamports: Number(cfg.priorityFeeLamports),
    });
    const stockAta = associatedTokenAddress(wallet, stock, stockProgram);
    const tokenAta = associatedTokenAddress(wallet, token, tokenProgram);
    const writable = await rpc.getMultipleAccounts(checked.writableAddresses);
    checkWritableCustody({ wallet, writableAddresses: checked.writableAddresses, accounts: writable.accounts ?? [], allowed: [stockAta, tokenAta] });
    const guard = await host.simulateGuard({
      txBase64, wallet, ata: tokenAta, mint: token, side,
      expected: side === "buy" ? { baseOutRaw: minOutRaw, maxQuoteInRaw: amountRaw } : { qtyRaw: amountRaw, minQuoteOutRaw: minOutRaw },
      quote: { mint: stock, ata: stockAta, decimals, symbol },
    });
    if (side === "buy" && -BigInt(guard.quoteDeltaRaw) !== BigInt(amountRaw))
      throw new SwapCheckError("exact_input", `the simulation takes ${-BigInt(guard.quoteDeltaRaw)} raw ${symbol}, not exactly the ${amountRaw} ticket`);
    const post = guard.post ?? [];
    checkSafeAfter(post[1] ?? null, { wallet, mint: token, label: "token" });
    checkSafeAfter(post[2] ?? null, { wallet, mint: stock, label: symbol });
    return { checked, guard, stockAta, tokenAta };
  }

  /* ── the live entry, after the wait ─────────────────────────────────────────────── */
  async function attemptLive(pos) {
    const now = host.clock();
    const mint = pos.mint;
    if (!host.claimEntry(mint)) return { mint, skipped: "another entry is being signed" };
    X().counters.liveAttempts++;
    updateSnipe(xbook(), { ...pos, mint, liveAttempted: true, liveAttemptAt: now });
    const refuse = async (gate, message) => {
      X().attempts[mint] = { at: now, outcome: "refused", detail: gate };
      if (gate === "transaction_refused" || gate === "simulation_refused") X().counters.txRefused++;
      mark(pos.pool, { state: "refused_live", gate, message });
      say(`live ${short(mint)}: refused before signing, at ${gate} — ${message}`);
      await host.persist();
      return { mint, entered: false, refusedAt: gate, message };
    };
    try {
      const cfg = host.config();
      const signer = host.activeSigner();
      const wallet = signer.wallet();
      const auto = host.isAutopilot(signer);
      const c = { pool: pos.pool, dex: pos.dex, sources: pos.sources ?? [], createdAtMs: pos.poolCreatedAtMs, firstSeenAt: pos.noticeAt,
        classification: { kind: "launch", stockMint: pos.quoteMint, stockSymbol: pos.quoteSymbol, tokenMint: mint, tokenSymbol: pos.symbol ?? null } };
      const v = await evaluate({ c, mode: "live", pos });
      if (v.deferred) return await refuse("jupiter_unavailable", `Jupiter could not be asked at the moment of the attempt (${v.message}); one attempt per pool, as on pump.fun`);
      if (!v.ok) return await refuse(v.gate, v.message);
      const t = v.ticket;
      const rpc = host.rpc();
      const stockAta = associatedTokenAddress(wallet, t.mint, v.stockProgram);
      /* THE WALLET MUST HOLD THE STOCK IT WOULD PAY, read before anything is built. */
      const held = BigInt(await rpc.getTokenAccountBalance(stockAta));
      if (held < t.ticketRaw) return await refuse("quote_balance_short", `the wallet holds ${units(held, t.decimals, t.symbol)}, under the ${units(t.ticketRaw, t.decimals, t.symbol)} this buy pays — nothing was ${auto ? "signed" : "asked of Phantom"}`);
      if (auto) {
        /* THE BUDGET IS THE BALANCE: the SOL for the fee, the token account's rent, one sell's
           fee and the rent floor. The ticket is in the stock. */
        const need = autopilotBuyNeedLamports(cfg, { ticketLamports: 0n, quoteAtaCreate: false });
        let balance = null;
        try { balance = BigInt(await rpc.getBalance(wallet)); } catch { balance = null; }
        if (balance === null || balance < need.total)
          return await refuse("autopilot_balance_short", `the autopilot wallet holds ${balance === null ? "an unread balance" : `${sol(balance)} SOL`}; this buy needs up to ${sol(need.total)} SOL of fee, rent, one sell's fee and the rent floor — nothing was signed`);
      }
      let swap, checked;
      try {
        swap = await jupiter.swapTransaction({ quote: v.buy.raw, wallet, priorityFeeLamports: cfg.priorityFeeLamports, priority: "live" });
        if (typeof swap?.swapTransaction !== "string" || !swap.swapTransaction) throw new SwapCheckError("malformed", "Jupiter returned no transaction");
        checked = await checkBeforeSigning({ txBase64: swap.swapTransaction, wallet, side: "buy", stock: t.mint, token: mint, stockProgram: v.stockProgram,
          tokenProgram: v.tokenProgram, amountRaw: t.ticketRaw, quote: v.buy.raw, minOutRaw: v.buy.minOutRaw, decimals: t.decimals, symbol: t.symbol });
      } catch (error) {
        if (error instanceof SwapCheckError) return await refuse("transaction_refused", `${error.clause}: ${error.message}`);
        if (error?.clause === "simulation_failed") return await refuse("simulation_refused", error.message);
        if (error instanceof JupiterError) {
          const gate = error.code === "no_route" ? "no_route" : ["rate_limited", "rate_budget", "network"].includes(error.code) ? "jupiter_unavailable" : "transaction_refused";
          return await refuse(gate, `Jupiter did not build the swap: ${error.message}`);
        }
        throw error;
      }
      return await enterForReal({ pos, v, swap, checked, wallet, signer, auto, now });
    } catch (error) {
      X().counters.entryFailures++;
      X().attempts[mint] = { at: now, outcome: "failed", detail: String(error?.message ?? error) };
      say(`live ${short(mint)}: the live attempt failed before anything was signed — ${error?.message ?? error}`);
      await host.persist();
      return { mint, entered: false, error: String(error?.message ?? error) };
    } finally { host.releaseEntry(); }
  }

  async function enterForReal({ pos, v, swap, checked, wallet, signer, auto, now }) {
    const mint = pos.mint;
    const t = v.ticket;
    const cfg = host.config();
    const u = (raw) => units(raw, t.decimals, t.symbol);
    X().attempts[mint] = { at: now, outcome: "signing", detail: auto ? "the autopilot wallet is signing" : "waiting for Phantom" };
    const summary = `BUY ${pos.symbol ?? short(mint)} through Jupiter (${pos.dex ?? "pool"}) — ${u(t.ticketRaw)} in, at least ${v.buy.minOutRaw} base out` +
      `${v.canary ? ` (the ${t.symbol} canary for this venue)` : ""}; network fee and rent in SOL`;
    if (!auto) host.notify({ kind: "buy", mint, title: "COINMARKETCAT: approve the buy in Phantom", body: summary });
    let signature = null;
    try {
      const signed = await host.signSendConfirm({ txBase64: swap.swapTransaction, purpose: "buy", mint, summary, lastValidBlockHeight: Number(swap.lastValidBlockHeight), timeoutMs: cfg.approvalTimeoutMs, wallet, signer });
      signature = signed.signature;
      /* From here the buy has LANDED: a failure below is a position the wallet holds that
         this book may not know about. */
      let fill;
      try { fill = fillFromTransaction(signed.tx, { wallet, mint, side: "buy", quoteMint: t.mint, quoteDecimals: t.decimals }); }
      catch (error) { return await block({ stock: t, mint, signature, now, detail: `its fill could not be read back (${error?.message ?? error})`, modelled: v.solCost }); }
      const openedAt = host.clock();
      const quoteInRaw = BigInt(fill.quoteInRaw);
      const paidLamports = BigInt(fill.feeLamports) + BigInt(fill.rentLamports);
      const sizeSol = Number(rawToUnits(quoteInRaw, t.decimals));
      const position = host.determiner.open({ mint, entry: 1, openedAt, creator: null, sizeSol, feeSolPerLeg: 0 });
      const paper = snipeFor(xbook(), mint);
      if (paper) closeSnipe(xbook(), mint, { reason: "superseded by the live fill", closedAt: openedAt });
      try {
        openSnipe(xbook(), {
          ...position, mint, venue: XSTOCK_VENUE_ID, entry: 1, openedAt, sizeSol, feeSolPerLeg: 0,
          qtyRaw: fill.qtyRaw, entryInputLamports: quoteInRaw.toString(), entryFeeLamports: "0",
          quoteMint: t.mint, quoteDecimals: t.decimals, quoteSymbol: t.symbol, quoteTokenProgram: v.stockProgram,
          networkFeeLamports: paidLamports.toString(), costBasisQuoteRaw: quoteInRaw.toString(), baseTokenProgram: v.tokenProgram,
          associatedBaseUser: checked.tokenAta, associatedQuoteUser: checked.stockAta,
          pool: pos.pool, dex: pos.dex, sources: pos.sources ?? [], poolCreatedAtMs: pos.poolCreatedAtMs, noticeAt: pos.noticeAt,
          creator: null, frictionXAtOpen: 1, samples: 0, live: true, entrySignature: signature, wallet, canary: v.canary,
          name: pos.name ?? null, symbol: pos.symbol ?? null, msSinceNotice: openedAt - Number(pos.noticeAt), lastTickAt: openedAt,
        });
      } catch (error) {
        host.chargeStock("entry", { quoteMint: t.mint, quoteRaw: quoteInRaw, quoteDecimals: t.decimals, lamports: paidLamports }, openedAt);
        return await block({ stock: t, mint, signature, now, charged: true, detail: `the book refused its fill (${error.clause ?? error.name}: ${error.message})` });
      }
      X().counters.entered++;
      X().attempts[mint] = { at: now, outcome: "entered", detail: signature };
      host.chargeStock("entry", { quoteMint: t.mint, quoteRaw: quoteInRaw, quoteDecimals: t.decimals, lamports: paidLamports }, openedAt);
      if ((X().canary[t.mint]?.state ?? "canary") !== "proven") {
        X().canary[t.mint] = { state: "proven", at: openedAt, signature, mint, quoteInRaw: quoteInRaw.toString(), qtyRaw: fill.qtyRaw };
        say(`the ${t.symbol} canary for this venue was read back off the chain (sig ${signature}): later ${t.symbol} buys here may use the full ${v.entry.maxPerTrade} ${t.symbol} ticket`);
      }
      mark(pos.pool, { state: "entered", gate: null, message: `bought ${fill.qtyRaw} base for ${u(quoteInRaw)}, sig ${signature}` });
      say(`live ${short(mint)}: ENTERED through Jupiter — ${fill.qtyRaw} base for ${u(quoteInRaw)}${v.canary ? " (the canary)" : ""}, plus ${paidLamports} lamports of fee and rent in SOL, ${auto ? "signed by the autopilot wallet, " : ""}sig ${signature}`);
      if (auto) host.notify({ kind: "buy", mint, title: "COINMARKETCAT autopilot: bought", body: `${pos.symbol ?? short(mint)} for ${u(quoteInRaw)} through Jupiter, signed by the autopilot wallet without a window.` });
      await host.persist();
      return { mint, entered: true, signature };
    } catch (error) {
      const code = error?.code ?? error?.clause ?? error?.name ?? "error";
      /* SENT, BUT ITS OUTCOME IS UNKNOWN: it may have landed. That is a position the book
         cannot see, so it blocks the stock here exactly as an unreadable fill does. */
      if (code === "ambiguous") return await block({ stock: t, mint, signature: error?.detail?.signature ?? signature, now, detail: `its outcome could not be read (${error?.message ?? error})`, modelled: v.solCost });
      X().counters.entryFailures++;
      X().attempts[mint] = { at: now, outcome: "failed", detail: `${code}: ${error?.message ?? error}` };
      if (code === SIGN_ERRORS.REJECTED) say(`live ${short(mint)}: you declined the ${t.symbol} buy in Phantom — the would-have row keeps watching`);
      else if (code === SIGN_ERRORS.TIMEOUT) say(`live ${short(mint)}: the Phantom window sat ${cfg.approvalTimeoutMs}ms without an answer — abandoned; the would-have row keeps watching`);
      else say(`live ${short(mint)}: ENTRY FAILED (${code}): ${error?.message ?? error}`);
      if (code === "failed_on_chain") host.charge("failed_entry_fee", BigInt(SNIPE_LANE_DEFAULTS.signatureFeeLamports) + BigInt(cfg.priorityFeeLamports), now);
      await host.persist();
      return { mint, entered: false, code, error: String(error?.message ?? error) };
    }
  }

  /** A buy that landed and could not be read back or booked: say so everywhere, charge the
   *  day as if the ticket and the modelled fee were spent (unless the real figures were
   *  charged), and block the stock in this venue. */
  async function block({ stock, mint, signature, now, detail, modelled = 0n, charged = false }) {
    X().counters.entryFailures++;
    if (!charged) host.chargeStock("entry_unread", { quoteMint: stock.mint, quoteRaw: stock.ticketRaw, quoteDecimals: stock.decimals, lamports: modelled }, host.clock());
    X().canary[stock.mint] = { state: "blocked", at: host.clock(), signature, mint, detail };
    X().attempts[mint] = { at: now, outcome: "unbooked", detail: `bought (${signature}) but ${detail}` };
    say(`live ${short(mint)}: BOUGHT WITH ${stock.symbol} THROUGH JUPITER BUT ${detail} — sig ${signature}; sell it by hand. ${stock.symbol} buys in this venue are BLOCKED until you check that signature and clear the block in the popup`);
    host.notify({ kind: "attention", mint, title: `COINMARKETCAT: a ${stock.symbol} buy the book could not take`, body: `${short(mint)} was bought through Jupiter (${signature}) but ${detail}. Sell it by hand. ${stock.symbol} buys in the xStock venue are blocked until you clear them.` });
    await host.persist();
    return { mint, entered: false, signature, blocked: true };
  }

  /* ── the held position, and the would-have one ──────────────────────────────────── */
  async function markOf(pos, priority) {
    const q = await jupiter.quote({ inputMint: pos.mint, outputMint: pos.quoteMint, amountRaw: pos.qtyRaw, slippageBps: Number(host.config().xstockSlippageBps), priority });
    const checked = checkQuote(q, { inputMint: pos.mint, outputMint: pos.quoteMint, amountRaw: pos.qtyRaw, slippageBps: Number(host.config().xstockSlippageBps), slippageCapBps: Number(host.config().xstockSlippageBps), maxPriceImpactPct: 100 });
    return { markX: ratioX(checked.outRaw, BigInt(pos.entryInputLamports)), quote: q, checked };
  }

  /** A would-have row whose entry decision is due: the lane is armed, the wait is over and
   *  it has not been attempted. Its mark decides a buy, so it waits for a Jupiter slot
   *  rather than being skipped like a routine sample. */
  const entryDue = (pos, now) => pos.live !== true && !pos.liveAttempted && now - Number(pos.openedAt) >= Number(host.config().entryWaitMs) && host.armed();

  async function stepPosition(pos) {
    const cfg = host.config();
    const now = host.clock();
    const live = pos.live === true;
    if (!live && pos.lastTickAt && now - Number(pos.lastTickAt) < Number(cfg.forwardIntervalMs) - 50) return { mint: pos.mint, action: "hold", skipped: true };
    let markX = null, markError = null;
    try { ({ markX } = await markOf(pos, live ? "live" : entryDue(pos, now) ? "entry" : "background")); }
    catch (error) {
      if (error instanceof JupiterError && error.code === "rate_budget") { X().counters.marksSkipped++; return { mint: pos.mint, action: "hold", skipped: true, reason: "no Jupiter slot" }; }
      markError = String(error?.message ?? error);
    }
    const step = host.determiner.step({ position: pos, markX, nowMs: now, cfg: host.observeCfg(), hardStop: host.control().hardStop === true, sample: { markX, nowMs: now, slot: null } });
    const samples = Number(pos.samples ?? 0) + 1;
    const aged = now - Number(pos.openedAt) >= Number(host.observeCfg().holdMaxMs);
    const wantsSell = step?.action === "sell" || aged;
    const reason = step?.action === "sell" ? step.reason : aged ? `hold clock: ${Math.round(Number(host.observeCfg().holdMaxMs) / 1000)}s in the position` : null;
    const carried = { ...pos, ...(step?.position && typeof step.position === "object" ? step.position : {}), mint: pos.mint, samples, lastMarkX: markX, lastTickAt: now, lastMarkError: markError };
    if (live && markError && (!pos.markErrorNotedAt || now - Number(pos.markErrorNotedAt) >= Number(cfg.sellReaskMs))) {
      /* A HELD POSITION JUPITER CANNOT PRICE is said out loud, once per re-ask interval: its
         exits cannot judge it, and a sell needs the same route. */
      carried.markErrorNotedAt = now;
      say(`live ${short(pos.mint)}: Jupiter cannot price this position right now (${markError}) — its exits cannot fire until it can; the hold clock still runs. If this persists, sell it by hand and press Forget`);
    }

    if (!live) {
      const waited = now - Number(pos.openedAt) >= Number(cfg.entryWaitMs);
      const followed = Number(cfg.entryFollowThroughX) <= 0 || (markX !== null && markX >= Number(cfg.entryFollowThroughX));
      const openLive = host.liveCount();
      if (host.armed() && !pos.liveAttempted && !wantsSell && waited && host.entryInFlight() === null && openLive < Number(cfg.maxOpenPositions) && !host.control().pauseEntries && !host.control().hardStop) {
        if (followed) { updateSnipe(xbook(), carried); return attemptLive(snipeFor(xbook(), pos.mint)); }
        if (markX !== null) {
          X().counters.waitedOut++;
          const note = `marked ${markX.toFixed(3)}x after ${Math.round((now - Number(pos.openedAt)) / 1000)}s — nobody followed`;
          updateSnipe(xbook(), { ...carried, liveAttempted: true, waitedOut: note });
          mark(pos.pool, { state: "waited_out", message: `not bought: ${note}` });
          say(`${short(pos.mint)}: waited ${Math.round(Number(cfg.entryWaitMs) / 1000)}s and it marks ${markX.toFixed(3)}x of the would-have fill — nobody followed; not buying`);
          host.persist();
          return { mint: pos.mint, action: "hold", markX, waitedOut: true };
        }
      }
      const windowDone = samples >= Number(cfg.forwardSamples);
      if (!wantsSell && !windowDone) { updateSnipe(xbook(), carried); host.emit(); return { mint: pos.mint, action: "hold", markX }; }
      const realized = markX === null ? null : BigInt(Math.floor(markX * Number(BigInt(pos.entryInputLamports))));
      const closeReason = wantsSell ? reason : `window closed: ${samples} marks`;
      const closed = closeSnipe(xbook(), pos.mint, { reason: closeReason, closedAt: now, markX, realizedLamports: realized === null ? null : realized.toString(), paper: true });
      host.recordClose({ closed, pos, realized, now, signature: null });
      if (!pos.waitedOut) mark(pos.pool, { state: "closed", message: `would-have row closed — ${closeReason} (mark ${markX === null ? "unread" : `${markX.toFixed(4)}x`})` });
      say(`would-have ${short(pos.mint)}: ${wantsSell ? "would have SOLD" : "window closed"} — ${closeReason} (mark ${markX === null ? "unread" : markX.toFixed(4)}x)`);
      await host.persist();
      return { mint: pos.mint, action: wantsSell ? "sell" : "hold", markX, closed: true, paper: true };
    }
    if (!wantsSell) { updateSnipe(xbook(), carried); host.emit(); return { mint: pos.mint, action: "hold", markX }; }
    updateSnipe(xbook(), carried);
    return sellLive(snipeFor(xbook(), pos.mint), { reason, markX, now });
  }

  async function sellLive(pos, { reason, markX, now }) {
    const mint = pos.mint;
    const cfg = host.config();
    if (sellInFlight.has(mint)) return { mint, action: "sell", pending: true };
    if (pos.pendingSell && now - Number(pos.pendingSell.askedAt) < Number(cfg.sellReaskMs)) return { mint, action: "sell", pending: true };
    const signer = pos.wallet ? host.signerHolding(pos.wallet) : null;
    const wallet = signer ? signer.wallet() : null;
    if (!signer || !wallet || wallet !== pos.wallet) { say(`live ${short(mint)}: the wallet that holds this position (${pos.wallet ?? "?"}) is not connected — cannot sell it now`); return { mint, action: "sell", pending: true }; }
    const auto = host.isAutopilot(signer);
    if (auto && !host.readyOf(signer)) {
      if (!pos.lockedSellNotedAt || now - Number(pos.lockedSellNotedAt) >= Number(cfg.sellReaskMs)) {
        updateSnipe(xbook(), { ...pos, mint, lockedSellNotedAt: now });
        say(`live ${short(mint)}: the determiner says sell (${reason}) but the autopilot wallet that holds it is LOCKED — unlock it in the popup and it sells on the next tick`);
        host.notify({ kind: "sell", mint, title: "COINMARKETCAT: unlock the autopilot wallet to sell", body: `${pos.symbol ?? short(mint)} should be sold (${reason}), and the autopilot wallet holding it is locked.` });
      }
      return { mint, action: "sell", pending: true, locked: true };
    }
    sellInFlight.add(mint);
    const stock = { mint: pos.quoteMint, decimals: pos.quoteDecimals, symbol: pos.quoteSymbol ?? short(pos.quoteMint) };
    try {
      const rpc = host.rpc();
      /* A paused stock moves nothing: a sell that cannot settle is not asked for. */
      const stockRead = await rpc.getMultipleAccounts([stock.mint]);
      const facts = describeMint(stockRead.accounts?.[0] ?? null, stock.mint);
      if (facts.paused) {
        if (!pos.pausedSellNotedAt || now - Number(pos.pausedSellNotedAt) >= Number(cfg.sellReaskMs)) {
          updateSnipe(xbook(), { ...pos, mint, pausedSellNotedAt: now });
          say(`live ${short(mint)}: the determiner says sell (${reason}) but ${stock.symbol} is paused by its issuer — the sell cannot settle; holding and re-reading`);
        }
        return { mint, action: "sell", pending: true, paused: true };
      }
      const tokenAta = pos.associatedBaseUser ?? associatedTokenAddress(wallet, mint, pos.baseTokenProgram);
      const held = BigInt(await rpc.getTokenAccountBalance(tokenAta));
      if (held <= 0n) {
        const closed = closeSnipe(xbook(), mint, { reason: "gone: the wallet holds none of this mint — sold or moved by hand", closedAt: now, markX, realizedLamports: null, paper: false });
        host.recordClose({ closed, pos, realized: null, now, signature: null });
        say(`live ${short(mint)}: the wallet holds none of it — closed as sold by hand; the realized figure reads "not read"`);
        await host.persist();
        return { mint, action: "sell", closed: true };
      }
      const qty = BigInt(pos.qtyRaw);
      const amountRaw = held < qty ? held : qty;
      const slip = Number(cfg.xstockSlippageBps);
      const raw = await jupiter.quote({ inputMint: mint, outputMint: stock.mint, amountRaw, slippageBps: slip, priority: "live" });
      const q = checkQuote(raw, { inputMint: mint, outputMint: stock.mint, amountRaw, slippageBps: slip, slippageCapBps: slip, maxPriceImpactPct: 100 });
      const swap = await jupiter.swapTransaction({ quote: raw, wallet, priorityFeeLamports: cfg.priorityFeeLamports, priority: "live" });
      if (typeof swap?.swapTransaction !== "string" || !swap.swapTransaction) throw new SwapCheckError("malformed", "Jupiter returned no transaction");
      await checkBeforeSigning({ txBase64: swap.swapTransaction, wallet, side: "sell", stock: stock.mint, token: mint, stockProgram: pos.quoteTokenProgram,
        tokenProgram: pos.baseTokenProgram, amountRaw, quote: raw, minOutRaw: q.minOutRaw, decimals: stock.decimals, symbol: stock.symbol });
      const summary = `SELL ${pos.symbol ?? short(mint)} through Jupiter — ${reason}; floor ${units(q.minOutRaw, stock.decimals, stock.symbol)}; network fee in SOL`;
      updateSnipe(xbook(), { ...snipeFor(xbook(), mint), mint, pendingSell: { reason, askedAt: host.clock(), attempts: Number(pos.pendingSell?.attempts ?? 0) + 1 } });
      if (!auto) host.notify({ kind: "sell", mint, title: "COINMARKETCAT: APPROVE THE SELL IN PHANTOM", body: summary });
      say(`live ${short(mint)}: ${auto ? "the autopilot wallet is selling" : "asking Phantom to sell"} through Jupiter — ${reason}`);
      host.emit();
      const signed = await host.signSendConfirm({ txBase64: swap.swapTransaction, purpose: "sell", mint, summary, lastValidBlockHeight: Number(swap.lastValidBlockHeight), timeoutMs: Number(cfg.sellReaskMs) * 4, wallet, signer });
      const fill = fillFromTransaction(signed.tx, { wallet, mint, side: "sell", quoteMint: stock.mint, quoteDecimals: stock.decimals });
      const realized = BigInt(fill.quoteOutRaw);
      const exitLamports = BigInt(fill.feeLamports) + BigInt(fill.rentLamports);
      const closedAt = host.clock();
      const closed = closeSnipe(xbook(), mint, { reason, closedAt, markX, realizedLamports: realized.toString(), sellSignature: signed.signature, paper: false, soldRaw: fill.qtyRaw });
      X().counters.sold++;
      if (exitLamports > 0n) host.charge("exit_fee", exitLamports, closedAt);
      host.recordClose({ closed, pos, realized, now: closedAt, signature: signed.signature, exitLamports });
      mark(pos.pool, { state: "sold", message: `sold — ${reason}; ${units(realized, stock.decimals, stock.symbol)} back, sig ${signed.signature}` });
      say(`live ${short(mint)}: SOLD through Jupiter — ${reason}; ${units(realized, stock.decimals, stock.symbol)} back, ${exitLamports} lamports of network fee in SOL, ${auto ? "signed by the autopilot wallet, " : ""}sig ${signed.signature}`);
      if (auto) host.notify({ kind: "sold", mint, title: "COINMARKETCAT autopilot: sold", body: `${pos.symbol ?? short(mint)} — ${reason}. Signed by the autopilot wallet without a window.` });
      await host.persist();
      return { mint, action: "sell", closed: true, signature: signed.signature };
    } catch (error) {
      X().counters.sellFailures++;
      const code = error?.code ?? error?.clause ?? error?.name ?? "error";
      if (code === SIGN_ERRORS.REJECTED || code === SIGN_ERRORS.TIMEOUT)
        say(`live ${short(mint)}: the sell was ${code === SIGN_ERRORS.REJECTED ? "declined" : "not answered"} in Phantom — the determiner still says ${reason}; asking again in ${Math.round(Number(cfg.sellReaskMs) / 1000)}s`);
      else say(`live ${short(mint)}: SELL NOT DONE (${code}): ${error?.message ?? error} — asking again next tick`);
      const current = snipeFor(xbook(), mint);
      if (current) updateSnipe(xbook(), { ...current, mint, pendingSell: { reason, askedAt: host.clock(), attempts: Number(current.pendingSell?.attempts ?? 1), lastError: `${code}: ${error?.message ?? error}` } });
      await host.persist();
      return { mint, action: "sell", closed: false, code, error: String(error?.message ?? error) };
    } finally { sellInFlight.delete(mint); host.emit(); }
  }

  /* ── the tick ───────────────────────────────────────────────────────────────────── */
  /** Discovery runs only while the venue is on and the lane is not off. A position this
   *  venue HOLDS is stepped on every tick whatever the switches say — turning the venue off
   *  must never strand a live position without its exits — and a would-have row is closed. */
  async function tick() {
    if (ticking) return [];
    const cfg = host.config();
    const discovering = cfg.xstockVenue === true && cfg.lane !== "off";
    if (!discovering && rows().length === 0) return [];
    ticking = true;
    const out = [];
    try {
      const now = host.clock();
      if (!discovering) {
        for (const pos of rows()) {
          if (pos.live === true) { try { out.push(await stepPosition(pos)); } catch (error) { say(`${short(pos.mint)}: tick failed — ${error?.message ?? error}`); } continue; }
          const closed = closeSnipe(xbook(), pos.mint, { reason: "the xStock venue or the lane was turned off", closedAt: now, markX: pos.lastMarkX ?? null, realizedLamports: null, paper: true });
          host.recordClose({ closed, pos, realized: null, now, signature: null });
          mark(pos.pool, { state: "closed", message: "would-have row closed: the venue or the lane was turned off" });
        }
        X().pending = [];
        return out;
      }
      if (now - Number(X().lastPollAt ?? 0) >= Number(cfg.xstockPollMs)) {
        X().lastPollAt = now;
        X().counters.polls++;
        let fresh = [];
        try { fresh = await discovery.poll(); } catch (error) { say(`discovery failed: ${error?.message ?? error}`); }
        for (const c of fresh) {
          X().counters.candidates++;
          X().candidates.unshift(candidateRow(c));
          if (X().candidates.length > CANDIDATES_KEPT) X().candidates.length = CANDIDATES_KEPT;
          out.push(await judge(c));
        }
      }
      const retry = X().pending.shift();
      if (retry) out.push(await judge(retry));
      /* One Jupiter request every ~2 s is shared by every row: held positions first, then a
         row whose entry decision is due, then the row marked longest ago — so no would-have
         row is starved of the mark that decides its entry by another that is only sampling. */
      const rank = (p) => (p.live === true ? 0 : entryDue(p, now) ? 1 : 2);
      const ordered = [...rows()].sort((a, b) => (rank(a) - rank(b)) || (Number(a.lastTickAt ?? 0) - Number(b.lastTickAt ?? 0)));
      for (const pos of ordered) {
        try { out.push(await stepPosition(pos)); }
        catch (error) { say(`${short(pos.mint)}: tick failed — ${error?.message ?? error}`); }
      }
      return out;
    } finally { ticking = false; host.emit(); }
  }

  async function clearBlock(stockMint) {
    const c = X().canary[stockMint];
    if (!c || c.state !== "blocked") return false;
    delete X().canary[stockMint];
    say(`${quoteEntryFor(host.config(), stockMint)?.symbol ?? short(stockMint)}: the block is cleared by the operator — the next buy in it in this venue is a canary again`);
    await host.persist();
    return true;
  }

  async function forget(mint) {
    const pos = snipeFor(xbook(), mint);
    if (!pos) return false;
    const now = host.clock();
    const closed = closeSnipe(xbook(), mint, { reason: "forgotten: closed by the operator, sold by hand", closedAt: now, markX: pos.lastMarkX ?? null, realizedLamports: null, paper: pos.live !== true });
    host.recordClose({ closed, pos, realized: null, now, signature: null });
    say(`${short(mint)}: forgotten — the realized figure reads "not read"`);
    await host.persist();
    return true;
  }

  function status() {
    const cfg = host.config();
    const now = host.clock();
    return {
      venue: XSTOCK_VENUE_ID, enabled: cfg.xstockVenue === true, sources: [...(cfg.xstockSources ?? [])],
      focus: xstockFocusList(cfg).map((f) => ({ mint: f.mint, symbol: f.symbol, listed: f.listed })),
      canary: Object.fromEntries(Object.entries(X().canary).map(([m, c]) => [m, { state: c.state, signature: c.signature ?? null, detail: c.detail ?? null }])),
      canaryRule: XSTOCK_CANARY_RULE, unmeasured: XSTOCK_UNMEASURED,
      candidates: X().candidates.slice(0, 30).map((c) => ({ ...c, sources: [...c.sources] })),
      pending: X().pending.length, counters: { ...X().counters }, pollMs: Number(cfg.xstockPollMs),
      lastPollAt: X().lastPollAt || null, nextPollInMs: X().lastPollAt ? Math.max(0, Number(X().lastPollAt) + Number(cfg.xstockPollMs) - now) : 0,
      discovery: discovery.status(), jupiter: jupiter.status(),
      open: rows().map((p) => ({ ...p })),
    };
  }

  return Object.freeze({ tick, status, clearBlock, forget, rows, liveCount: () => liveRows().length, holds: (mint) => Boolean(snipeFor(xbook(), mint)), evaluate });
}
