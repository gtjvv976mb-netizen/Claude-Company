/* WHAT THE PUBLIC PAGE IS ALLOWED TO SAY ABOUT HAWK-AI, COMPUTED IN ONE PLACE.
 *
 * The sniper's panel is public and ungated, so every claim on it reaches anyone. Its first
 * version stated those claims as sentences typed into the HTML — "Bought · 0", "No
 * keypair" — and its own header comment argued that a panel which POLLS a machine would
 * eventually paint a live number beside a bot that had never traded. That reasoning was
 * right and it inverted the moment the lane gained dials: a hand-written claim does not go
 * stale loudly, it goes stale silently.
 *
 * TWO CONSUMERS, ONE ANSWER. scripts/build-viewer.mjs bakes this into the static site and
 * src/office.js substitutes it when it serves the same page live. Those are two different
 * hosts for one page, and the reason this is a module rather than a copy in each is that
 * four copies of a money ceiling already drifted once in this repo and made a raise
 * unarmable — see test-operator-max-parity.mjs, which exists because of it.
 *
 * It imports the REAL lane, the REAL venue and the REAL policy. Nothing here decides
 * anything; it only asks and reports.
 */
import { snipeLaneConfig, armabilityReport, SNIPE_OPERATOR_MAX } from "./snipe-lane.mjs";
import { PUMPFUN_VENUE } from "./snipe-venue-pumpfun.mjs";
import { SNIPE_DEFAULTS, frictionX, takeRealizedFrac } from "./snipe-policy.mjs";

/** The placeholder both consumers replace. A quoted string so the page parses unsubstituted. */
export const HAWK_STATUS_TOKEN = '"__CLAUDE_COMPANY_HAWK_STATUS__"';

/**
 * The shipped configuration's armability, plus the dials, as plain JSON-safe data.
 * Never throws: a page that cannot compute its own status must render an explicit
 * "unknown" rather than fall back to something reassuring.
 */
export function hawkStatus() {
  try {
    const cfg = snipeLaneConfig({ SNIPE_LANE: "observe" });
    const report = armabilityReport({ cfg, venue: PUMPFUN_VENUE });
    const fx = frictionX({ sizeSol: cfg.maxSolPerTrade, feeSolPerLeg: cfg.networkFeeReserveSol });
    const take = SNIPE_DEFAULTS.takeAtEntryX;
    return {
      armable: report.armable,
      blocking: [...report.blocking],
      items: report.items.map((i) => ({ name: i.name, ok: i.ok, detail: i.detail })),
      dials: {
        takeAtEntryX: take,
        sizeSol: cfg.maxSolPerTrade,
        operatorMaxSol: SNIPE_OPERATOR_MAX.maxSolPerTrade,
        stopFrac: SNIPE_DEFAULTS.stopFrac,
        frictionX: fx,
        takeRealizedFrac: takeRealizedFrac({ takeAtEntryX: take, frictionX: fx }),
      },
    };
  } catch (err) {
    return { armable: false, blocking: ["status_unavailable"], items: [], dials: null,
      error: String(err?.message || err) };
  }
}

/**
 * Substitute the status into a page.
 *
 * JSON.stringify twice is deliberate and load-bearing: the inner value is embedded as a
 * STRING LITERAL which the page parses at runtime, so no quote, backslash or `</script>`
 * inside a refusal message can break out of the surrounding script tag. A refusal message
 * is prose written by whoever wrote the guard, and prose eventually contains a quote.
 */
export function injectHawkStatus(html, status = hawkStatus()) {
  return String(html).replaceAll(HAWK_STATUS_TOKEN, JSON.stringify(JSON.stringify(status)));
}
