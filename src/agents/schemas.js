import { z } from "zod";

export const Finding = z.object({
  claim: z.string().describe("One specific assertion, stated plainly."),
  value: z.string().describe("The actual number or fact behind the claim."),
  source: z.string().describe("Evidence key path (e.g. 'pair.liquidityUsd'), a URL you read, or 'inference'."),
});

/** Every analyst seat answers in this shape so the PM can weigh them like for like. */
export const AnalystOut = z.object({
  headline: z.string().describe("One sentence a portfolio manager could act on."),
  score: z.number().min(0).max(100).describe("0 = disqualifying, 50 = neutral, 100 = exceptional, on YOUR dimension only."),
  confidence: z.number().min(0).max(1).describe("Lower this when evidence was missing. Do not fake certainty."),
  findings: z.array(Finding),
  risks: z.array(z.string()).describe("What could go wrong on your dimension specifically."),
  missing_data: z.array(z.string()).describe("Data you needed and did not get."),
  kill: z.boolean().describe("True only for a disqualifying defect on your dimension. A kill stops the pipeline."),
  kill_reason: z.string().describe("Empty string when kill is false."),
});

export const ScoutOut = z.object({
  picks: z.array(z.object({
    mint: z.string(),
    why_now: z.string().describe("The specific, time-sensitive reason this deserves attention today."),
    interest: z.number().min(0).max(100),
  })),
  discarded_reasoning: z.string(),
});

export const RedTeamOut = z.object({
  headline: z.string().describe("The single strongest reason this trade loses money."),
  bear_case: z.string(),
  attacks: z.array(z.object({
    target: z.string().describe("Which analyst claim or assumption you are attacking."),
    attack: z.string(),
    severity: z.enum(["fatal", "serious", "minor"]),
    evidence: z.string(),
  })),
  unfalsifiable_claims: z.array(z.string()).describe("Bull-case claims that cannot be checked and should carry no weight."),
  what_would_change_my_mind: z.string(),
  verdict: z.enum(["refuted", "wounded", "survives"]),
  confidence: z.number().min(0).max(1),
});

export const RiskOut = z.object({
  position_size_usd: z.number().describe("Recommended notional. May be 0."),
  size_rationale: z.string(),
  stop_price: z.number().describe("Price at which the thesis is mechanically wrong. 0 if not applicable."),
  stop_rationale: z.string(),
  max_loss_usd: z.number(),
  pct_of_equity_at_risk: z.number(),
  liquidity_adjusted: z.boolean().describe("True if you reduced size because the exit probe said you could not get out at full size."),
  portfolio_notes: z.string(),
  confidence: z.number().min(0).max(1),
});

export const PMOut = z.object({
  decision: z.enum(["PROPOSE", "WATCH", "PASS"]),
  conviction: z.number().min(0).max(100),
  thesis: z.string().describe("Why this makes money, in plain language, in under 80 words."),
  invalidation: z.string().describe("The specific observable that proves the thesis wrong."),
  time_horizon: z.string(),
  how_red_team_was_answered: z.string().describe("Required. If you cannot answer the red team, the decision is not PROPOSE."),
  key_disagreement: z.string().describe("Where the analysts conflicted and how you resolved it."),
  watch_triggers: z.array(z.string()).describe("For WATCH: what would promote this to PROPOSE."),
  watch_rules: z.object({
    price_above_usd: z.number().nullable().describe("Promote when price holds above this. Null if not a condition."),
    buys_h1_at_least: z.number().nullable().describe("Promote when hourly buys reach this. Null if not a condition."),
    liq_at_least_usd: z.number().nullable().describe("Promote when liquidity reaches this. Null if not a condition."),
    hours: z.number().min(1).max(72).describe("How long the watch stands before it expires."),
  }).nullable().describe("For WATCH only, otherwise null. MACHINE-CHECKABLE promotion rules — the desk re-runs this token automatically when every non-null rule holds. A WATCH without rules is a PASS that lies about itself."),
});

export const TicketOut = z.object({
  action: z.literal("BUY").describe("This desk proposes long entries only."),
  entry_zone_low: z.number(),
  entry_zone_high: z.number(),
  entry_style: z.enum(["market", "limit", "scale-in"]),
  slices: z.array(z.object({
    pct_of_position: z.number(),
    trigger: z.string(),
  })),
  max_slippage_bps: z.number(),
  suggested_route: z.string().describe("Venue/aggregator from the evidence route data."),
  stop_price: z.number(),
  take_profit: z.array(z.object({ price: z.number(), pct_to_sell: z.number(), rationale: z.string() })),
  execution_warnings: z.array(z.string()),
});
