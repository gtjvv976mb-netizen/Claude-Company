import * as ds from "./dexscreener.js";
import * as jup from "./jupiter.js";
import * as sol from "./solana.js";
import { cfg, MINTS } from "../config.js";
import * as snapshots from "./snapshots.js";
import { grokXRead, hasGrok } from "../lib/grok.js";
import { emit } from "../lib/bus.js";
import { whaleFeed } from "../identity.js";
import * as pf from "./pumpfun.js";
import { regime } from "./regime.js";

/**
 * Everything the desk knows about one token, fetched deterministically.
 * This object is the ONLY numeric ground truth the agents are permitted to use.
 */
export async function gather(mint, hook = "") {
  emit("evidence:fetch", { mint });

  const px = await ds.pairsFor(mint);
  if (!px.ok) return { ok: false, mint, error: `dexscreener: ${px.error}` };

  // Never price off pairs[0]. See dexscreener.consensus() — the deepest REPORTED pool
  // can be a broken one, and RAY was killed on a price 5,000x its real market.
  const cons = ds.consensus(px.pairs);
  if (!cons.ok) return { ok: false, mint, error: `pricing: ${cons.error}` };
  const best = ds.shapePair(cons.deepest);
  if (best) best.priceUsd = cons.priceUsd;              // the consensus mark, not one pool's quote
  const totalLiquidityUsd = cons.liquidityUsd;

  const mintAcct = await sol.mintInfo(mint);
  const holders = mintAcct.ok && mintAcct.supply
    ? await sol.topHolders(mint, mintAcct.supply)
    : { ok: false, error: "mint info unavailable" };

  // Exitability probe at the desk's real target size, quoted in USDC.
  const usdcRaw = Math.round(cfg.targetSizeUsd * 1e6);
  const rt = await jup.roundTrip({ quoteMint: MINTS.USDC, tokenMint: mint, quoteAmountRaw: String(usdcRaw) });

  const jp = await jup.price([mint]);
  const jupPrice = jp?.[mint] ?? null;

  // The two questions every memecoin call must answer about its attention:
  // is it PAID FOR (DexScreener boosts/ads — bought reach, not organic demand),
  // and was it CALLED OUT (our own recorded whale callouts for this mint).
  const promo = await ds.paidOrders(mint);
  const approved = promo.orders.filter((o) => o.status === "approved");
  const promotion = {
    boosted: approved.length > 0,
    paidOrders: approved.length,
    lastPaidAt: approved.reduce((m, o) => Math.max(m, o.paidAt ?? 0), 0) || null,
  };
  const callouts = whaleFeed({ limit: 200 }).filter((w) => w.mint === mint).slice(0, 5);
  const marketRegime = await regime().catch(() => ({ regime: "unknown" }));

  // Who created it — the doctrine's deferred question, answered where it is
  // answerable (pump.fun coins) and skipped on monitor ticks, which need prices,
  // not biographies. Best-effort: an API failure reads as unknown, never a block.
  let deployer = null;
  if (hook !== "monitor" && mint.endsWith("pump")) {
    deployer = await pf.deployerProfile(mint).catch(() => null);
    if (deployer && !deployer.ok) deployer = { note: deployer.note ?? "deployer unknown" };
  }

  /* THE X READ USED TO HAPPEN HERE, AND IT COSTS MONEY.
   *
   * gather() is free evidence — DexScreener, RPC, Jupiter. Grok's x_search is not, and
   * running it here meant the desk paid to research the reputation of every coin it was
   * about to reject as a honeypot. Measured: 107 paid X reads against 235 screen kills.
   *
   * Safety is now the FIRST gate, as it should always have been. Nothing is bought
   * about a coin until the deterministic screen has said it can be held and sold:
   * mint and freeze authority, an exit that closes, holder concentration, the launch
   * farm, the bundle. Only then does the desk pay to ask who is promoting it.
   *
   * See enrichWithXRead below, called from workup() after the screen passes. */
  const vol24 = best?.volume?.h24 ?? null;
  // Depth must be measured across ALL venues, not the single deepest pair. A token
  // trading on 30 pools looks fraudulently thin if you only price the biggest one.
  const liq = Number(totalLiquidityUsd.toFixed(2)) || null;
  const txns24 = (best?.txns?.h24?.buys ?? 0) + (best?.txns?.h24?.sells ?? 0);

  /* THE PINOCCHIO GATE — data hygiene as a pipeline stage, copied from the one
   * discipline every serious desk shares (GROKSTREET's verification seat, and
   * RenTec folklore before it): every load-bearing number is cross-checked
   * against an INDEPENDENT source before anyone reasons on it. Three outcomes:
   * VERIFIED, WRONG, KILLED — and unverifiable is a kill, not a pass. We fetch
   * a second price (Jupiter) alongside DexScreener consensus anyway; until now
   * nobody compared them. */
  const crosscheck = { verdicts: [], killed: false };
  const xc = (verdict, check, detail) => {
    crosscheck.verdicts.push({ check, verdict, detail });
    if (verdict === "KILLED") crosscheck.killed = true;
  };
  const jupUsd = jupPrice?.usdPrice ?? null;
  if (jupUsd && cons.priceUsd > 0) {
    const gapPct = Math.abs(jupUsd - cons.priceUsd) / cons.priceUsd * 100;
    if (gapPct > 25) xc("KILLED", "price_disputed",
      `DexScreener consensus $${cons.priceUsd} vs Jupiter $${jupUsd} disagree by ${gapPct.toFixed(0)}% — the mark is unverifiable`);
    else xc("VERIFIED", "price", `two independent sources agree within ${gapPct.toFixed(1)}%`);
  } else {
    xc("FLAG", "price_single_source", "only one price source answered — treat the mark with suspicion");
  }
  if ((vol24 ?? 0) > 10_000 && txns24 === 0)
    xc("KILLED", "volume_without_trades", `$${Math.round(vol24)} of volume with zero recorded trades is not a market`);
  if (cons.priceSpreadPct > 25)
    xc("FLAG", "venue_spread", `surviving pools still disagree by ${cons.priceSpreadPct}% — a wobbly mark`);
  const avgTrade = vol24 && txns24 ? vol24 / txns24 : null;
  if (avgTrade != null && avgTrade > 50_000)
    xc("FLAG", "suspicious_print", `average trade $${Math.round(avgTrade)} — a whale or a wash, and the tape cannot say which`);
  const tokenBorn = deployer?.coin?.createdAt ?? null;
  if (tokenBorn && best?.pairCreatedAt && best.pairCreatedAt < tokenBorn - 3600e3)
    xc("KILLED", "impossible_age", "the pair predates the token's own creation — the identity is wrong");

  return {
    ok: true,
    promotion, callouts, deployer, marketRegime, crosscheck, xRead,
    mint,
    hook,
    symbol: best?.baseSymbol ?? "?",
    name: best?.baseName ?? "?",
    fetchedAt: new Date().toISOString(),
    pair: best,
    pairs: {
      count: px.pairs.length,
      totalLiquidityUsd: Number(totalLiquidityUsd.toFixed(2)),
      venues: [...new Set(px.pairs.map((p) => p.dexId))],
    },
    mintAccount: mintAcct.ok ? mintAcct : { error: mintAcct.error },
    holders: holders.ok ? holders : { error: holders.error },
    exitProbe: rt.ok
      ? { targetSizeUsd: cfg.targetSizeUsd, ...rt }
      : { targetSizeUsd: cfg.targetSizeUsd, error: rt.error },
    jupPrice,
    derived: {
      totalLiquidityUsd: liq,
      volToLiqRatio: vol24 && liq ? Number((vol24 / liq).toFixed(2)) : null,
      fdvToLiqRatio: best?.fdv && liq ? Number((best.fdv / liq).toFixed(1)) : null,
      buySellRatio24h: best?.txns?.h24?.sells ? Number(((best.txns.h24.buys || 0) / best.txns.h24.sells).toFixed(2)) : null,
      txns24h: txns24,
      avgTradeSizeUsd: vol24 && txns24 ? Number((vol24 / txns24).toFixed(2)) : null,
    },
  };
}

/**
 * SCREENER — stage 1, pure code, zero tokens. Deterministic floors from the charter.
 * The point of this stage is that the expensive stages never see garbage.
 */
export function screen(ev) {
  const fails = [];
  const s = cfg.screen;
  const p = ev.pair || {};
  const d = ev.derived || {};

  const check = (cond, code, detail) => { if (cond) fails.push({ code, detail }); };

  // The launch farm: many priors, none ever graduated. Fires only on POSITIVE
  // evidence — a coin whose deployer we could not identify passes this check,
  // because "unknown" must never be an execution.
  const dep = ev.deployer;
  check(dep?.ok && dep.priorLaunches >= 8 && dep.graduated === 0,
    "serial_deployer",
    dep?.ok ? `deployer shipped ${dep.priorLaunches}+ coins, zero ever graduated` : null);

  const totalLiq = ev.pairs?.totalLiquidityUsd ?? p.liquidityUsd;
  check(totalLiq == null || totalLiq < s.minLiquidityUsd,
    "thin_liquidity", `total liquidity across ${ev.pairs?.count} venues = ${totalLiq} < floor ${s.minLiquidityUsd}`);
  check(p.ageHours == null || p.ageHours < s.minPairAgeHours,
    "too_new", `ageHours=${p.ageHours} < floor ${s.minPairAgeHours}`);
  check((p.volume?.h24 ?? 0) < s.minVolume24hUsd,
    "no_volume", `volume.h24=${p.volume?.h24} < floor ${s.minVolume24hUsd}`);
  // Was `s.minTxns24`, which is undefined — so `n < undefined` was always false and this
  // screen never fired once. The config key is minTxns24h.
  check(d.txns24h < s.minTxns24h,
    "no_participants", `txns24h=${d.txns24h} < floor ${s.minTxns24h}`);
  check(d.volToLiqRatio != null && d.volToLiqRatio > s.maxVolToLiqRatio,
    "wash_suspect", `volume/liquidity=${d.volToLiqRatio} > ceiling ${s.maxVolToLiqRatio}`);
  check(d.fdvToLiqRatio != null && d.fdvToLiqRatio > s.maxFdvToLiqRatio,
    "fdv_propped", `fdv/liquidity=${d.fdvToLiqRatio} > ceiling ${s.maxFdvToLiqRatio}`);

  /* TOO BIG TO RE-RATE. Not a safety fact — a coin this size is perfectly tradeable,
   * it simply is not the trade this desk exists to find. A memecoin thesis is a claim
   * that a coin can re-rate; past the ceiling that needs millions of fresh money to
   * arrive, which is a different business. Unknown market cap never fails this: an
   * unreadable number must not become an execution. */
  const mcap = p.marketCap ?? p.fdv ?? null;
  check(s.maxMarketCapUsd > 0 && mcap != null && mcap > s.maxMarketCapUsd,
    "too_big", `market cap $${Math.round(mcap ?? 0).toLocaleString()} is over the ` +
      `$${Math.round(s.maxMarketCapUsd || 0).toLocaleString()} ceiling — above the board`);
  // Below the board's floor there is not enough coin to trade and the pool is one wallet.
  check(s.minMarketCapUsd > 0 && mcap != null && mcap < s.minMarketCapUsd,
    "too_small", `market cap $${Math.round(mcap ?? 0).toLocaleString()} is under the ` +
      `$${Math.round(s.minMarketCapUsd || 0).toLocaleString()} floor — too little coin to trade`);

  check(ev.exitProbe?.roundTripLossPct != null && ev.exitProbe.roundTripLossPct > cfg.maxRoundTripSlippagePct,
    "cannot_exit", `round-trip loss ${ev.exitProbe.roundTripLossPct}% > ceiling ${cfg.maxRoundTripSlippagePct}% at $${cfg.targetSizeUsd}`);

  // The Pinocchio gate's hard kills: a desk must never reason on a number that
  // two independent sources cannot agree exists.
  for (const c of (ev.crosscheck?.verdicts ?? []).filter((v) => v.verdict === "KILLED"))
    check(true, c.check, c.detail);

  // A live freeze authority is a honeypot vector no quote can see: a Jupiter
  // round trip proves a ROUTE exists, not that your transfer will execute.
  /* THE HONEYPOT MECHANICS. Every one of these is a way the token can be used against
   * whoever holds it, and every one is readable from the mint account for free — so
   * they belong HERE, in the first gate, before the desk spends anything researching
   * who is promoting the coin.
   *
   * Two of these were previously only a seat's OPINION. The forensics analyst called a
   * live mint authority "near-disqualifying unless there is a credible, verifiable
   * reason (e.g. a documented emissions schedule)" — which is the right nuance for an
   * asset that HAS an emissions schedule, and no nuance at all for a memecoin, where a
   * live mint authority simply means the creator can print supply and sell it to you.
   * Leaving that to a judgement call put a printable coin in front of the paid seats,
   * and let it through whenever the seat was feeling generous.
   *
   * A permanentDelegate can take the tokens out of your wallet. A transferHook runs
   * arbitrary code on every transfer and can refuse your sell. Those are not risks to
   * be priced, they are the trade being a trap, and no conviction score should be able
   * to outvote them. */
  /* UNVERIFIED IS NOT SAFE. This is the asymmetry the desk was missing.
   *
   * Everywhere else, an unknown is deliberately not held against a coin: an unreadable
   * market cap does not fail the size band, an unfindable dev is not a rugger. That is
   * right, because those are OPPORTUNITY questions and refusing to guess is honest.
   *
   * Safety inverts it. Every check below reads a fact from the chain, and when the read
   * FAILS the check simply does not fire — so an unreadable mint account produced the
   * same silent pass as a clean one, and the public RPC 429s often enough that this is
   * a routine event rather than an edge case. A honeypot whose mint account failed to
   * load walked straight through the gate.
   *
   * For safety, "we could not check" must never equal "it is fine". You are about to
   * put money into something you were unable to verify, and the only honest answer is
   * to decline and look at the next coin — of which there is one every half hour. */
  if (!ev.mintAccount || ev.mintAccount.error)
    check(true, "unverified_mint", `could not read the mint account (${ev.mintAccount?.error ?? "no data"}) — mint and freeze authority are UNKNOWN, not absent`);
  if (!ev.holders?.ok)
    check(true, "unverified_holders", `could not read holder distribution (${ev.holders?.error ?? "no data"}) — concentration and bundling are UNKNOWN`);
  if (ev.exitProbe?.roundTripLossPct == null)
    check(true, "unverified_exit", `the round-trip probe did not complete (${ev.exitProbe?.error ?? "no result"}) — whether this can be SOLD is unknown`);

  const flags = (ev.mintAccount?.flags ?? []).map((f) => f.flag ?? f);
  check(flags.includes("freeze_authority_live"),
    "freezable", "freeze authority is live — accounts can be frozen mid-trade");
  check(flags.includes("mint_authority_live"),
    "mintable", "mint authority is live — the creator can print supply and sell it to you");
  check(flags.includes("ext_permanentDelegate"),
    "seizable", "a permanent delegate can move or burn tokens out of your wallet without consent");
  check(flags.includes("ext_transferHook"),
    "transfer_hook", "an arbitrary program runs on every transfer and can block your sell entirely");
  check(flags.includes("ext_defaultAccountState"),
    "frozen_by_default", "new accounts are frozen by default — a buyer may be unable to sell");

  // One wallet holding half the float (pool already excluded upstream).
  check(ev.holders?.ok && ev.holders.top1Pct > 50,
    "holder_concentration", `largest non-pool account holds ${ev.holders?.top1Pct}% of supply`);

  // THE DEAD ZONE. Measured across 41,470 migrations: 73% of graduates trade
  // below 0.4x their migration price within 20 minutes — and DexScreener first
  // surfaces pairs exactly there, so our earliest sighting is structurally near
  // the worst entry. A young coin trading at less than half of what it was when
  // we FIRST saw it is a knife, not a discount.
  if (p.ageHours != null && p.ageHours < 72 && p.priceUsd) {
    const born = Date.now() - p.ageHours * 3600e3;
    const first = snapshots.firstSince(ev.mint, born);
    if (first && Date.now() - first.ts > 30 * 60e3 && first.price > 0) {
      const ratio = p.priceUsd / first.price;
      check(ratio < 0.5, "post_migration_dump",
        `trading at ${(ratio * 100).toFixed(0)}% of first-sighting price — the graduate dead zone`);
    }
  }

  // Liquidity that HELD, not liquidity that posed: rugs pass momentary
  // snapshots by design (median rug: $2,832). Applied once we have ~8h of
  // observations; the spot check above still guards the young.
  {
    const held = snapshots.liqOver(ev.mint, Date.now() - 24 * 3600e3);
    check(held.observations >= 96 && held.minLiq != null && held.minLiq < s.minLiquidityUsd,
      "liquidity_did_not_hold",
      `liquidity dipped to $${Math.round(held.minLiq)} inside 24h (floor $${s.minLiquidityUsd})`);
  }

  return { pass: fails.length === 0, fails };
}

/**
 * THE PAID HALF OF THE EVIDENCE — bought only for coins that already cleared safety.
 *
 * Split out of gather() deliberately. The screen is free and answers the question that
 * can disqualify a coin outright ("can this be used against a holder, and can I get
 * out"). Reputation research is expensive and answers a question that only matters
 * once the answer to the first one is yes.
 *
 * Mutates and returns `ev` so the caller keeps one evidence object; fails open, because
 * no X read is missing evidence, never a block.
 */
export async function enrichWithXRead(ev, hook = "") {
  if (hook === "monitor" || !hasGrok()) return ev;
  const xr = await grokXRead({ symbol: ev.pair?.baseSymbol ?? ev.mint.slice(0, 6), mint: ev.mint, hook })
    .catch(() => null);
  if (xr?.ok) ev.xRead = { ...xr.read, citations: xr.citations };
  else if (xr) ev.xRead = { error: xr.error };

  /* THE LEDGER. A rugger rotates wallets between launches, so on-chain forensics meets
   * a first-time deployer every time; the X handle is the identity they cannot abandon,
   * because the audience is the product. */
  if (ev.xRead?.dev_handle) {
    try {
      const { recordDev, reputationFor } = await import("../devrep.js");
      const prior = reputationFor(ev.xRead.dev_handle);
      recordDev({
        handle: ev.xRead.dev_handle, serialRugger: ev.xRead.serial_rugger,
        rugEvidence: ev.xRead.rug_evidence, redFlags: ev.xRead.dev_red_flags,
        deletedHistory: ev.xRead.deleted_history,
        symbol: ev.pair?.baseSymbol ?? null, mint: ev.mint,
      });
      if (prior && prior.verdict !== "unknown")
        ev.xRead.desk_record = { verdict: prior.verdict, evidence: prior.evidence,
          seen_before: prior.tokens.length, first_seen: prior.first_seen };
    } catch {}
  }
  return ev;
}
