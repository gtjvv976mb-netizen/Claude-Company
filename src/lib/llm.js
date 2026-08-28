import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { emit } from "./bus.js";
import { CHARTER } from "../config.js";

const client = new Anthropic();

// Anthropic list price, USD per 1M tokens. Used only for the desk's own
// running cost meter — it is not billing.
const PRICE = {
  "claude-opus-5":   { in: 5.0,  out: 25.0 },
  "claude-fable-5":  { in: 10.0, out: 50.0 },
  "claude-sonnet-5": { in: 2.0,  out: 10.0 },
  "claude-haiku-4-5":{ in: 1.0,  out: 5.0  },
};

export const spend = { usd: 0, calls: 0, inTok: 0, outTok: 0, cachedTok: 0 };

function meter(model, usage) {
  const p = PRICE[model] || PRICE["claude-opus-5"];
  const i = usage?.input_tokens ?? 0;
  const o = usage?.output_tokens ?? 0;
  const cached = usage?.cache_read_input_tokens ?? 0;
  spend.usd += (i / 1e6) * p.in + (o / 1e6) * p.out;
  spend.calls += 1;
  spend.inTok += i;
  spend.outTok += o;
  spend.cachedTok += cached;
}

const SHARED_RULES = `
You are a specialist on an automated Solana research desk called Claude Company ("Claude Co").
You hold exactly one seat. Do that seat's job and no other seat's job.

${CHARTER}

Operating rules for your reply:
- You are given an EVIDENCE bundle fetched deterministically by code. Treat it as the
  only source of numeric fact. Do not state any number that is not derivable from it.
- If a datum you need is missing or null, say so, lower your confidence, and proceed.
  Never substitute a plausible-looking figure for a missing one.
- Each finding needs a source: an evidence key path (e.g. "pair.liquidityUsd"),
  a URL you actually read, or the literal string "inference" when it is your judgment.
- Be concrete and terse. A number with a source beats a paragraph of adjectives.
- You are producing research for a human who will decide. You never execute anything.
`.trim();

export class Refusal extends Error {}

/**
 * One structured call to a seat. Returns the parsed object, validated against `schema`.
 * Throws after retries rather than returning a half-parsed shape — a seat that cannot
 * answer in contract is a seat that gets dropped, not one that gets guessed at.
 */
export async function ask({
  seat,
  model,
  effort = "high",
  schema,
  prompt,
  system,
  maxTokens = 8000,
  attempts = 3,
}) {
  let lastErr;
  for (let a = 1; a <= attempts; a++) {
    try {
      emit("seat:thinking", { seat, model, effort, attempt: a });
      const res = await client.beta.messages.parse({
        model,
        max_tokens: maxTokens,
        system: [
          { type: "text", text: SHARED_RULES, cache_control: { type: "ephemeral" } },
          ...(system ? [{ type: "text", text: system }] : []),
        ],
        messages: [{ role: "user", content: prompt }],
        output_config: { format: betaZodOutputFormat(schema), effort },
        // Server-side fallback: if a safety classifier declines, the request is
        // routed to a comparable model instead of failing the whole cycle.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });

      meter(model, res.usage);

      if (res.stop_reason === "refusal") {
        throw new Refusal(`${seat}: refused (${res.stop_details?.category ?? "unknown"})`);
      }
      const parsed = res.parsed_output ?? res.parsed;
      if (!parsed) throw new Error(`${seat}: response did not parse into contract`);

      emit("seat:done", { seat, usd: spend.usd });
      return parsed;
    } catch (err) {
      lastErr = err;
      if (err instanceof Refusal) throw err;
      const retryable =
        err?.status === 429 || err?.status >= 500 || err?.name === "APIConnectionError";
      emit("seat:retry", { seat, attempt: a, error: String(err?.message || err) });
      if (a === attempts || (!retryable && !/parse/.test(String(err?.message)))) break;
      await new Promise((r) => setTimeout(r, 800 * a * a));
    }
  }
  emit("seat:failed", { seat, error: String(lastErr?.message || lastErr) });
  throw lastErr;
}

/**
 * Two-step for the narrative seat: server-side web search cannot be combined with a
 * structured output format, so we search in one call and shape the result in a second.
 */
export async function askWithWeb({ seat, model, effort, schema, prompt, system, maxTokens = 8000 }) {
  emit("seat:searching", { seat, model });
  const research = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: SHARED_RULES + (system ? `\n\n${system}` : ""),
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 6 }],
    output_config: { effort },
    messages: [{ role: "user", content: prompt }],
  });
  meter(model, research.usage);

  const notes = research.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const cited = [];
  for (const block of research.content) {
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const r of block.content) if (r.url) cited.push(`${r.title ?? ""} — ${r.url}`);
    }
  }

  return ask({
    seat,
    model,
    effort: "low", // shaping already-gathered notes is mechanical
    schema,
    system,
    maxTokens,
    prompt:
      `Convert your own research notes into the required contract. Use ONLY what the notes support.\n\n` +
      `=== YOUR RESEARCH NOTES ===\n${notes}\n\n` +
      `=== SOURCES YOU ACTUALLY READ ===\n${cited.join("\n") || "(none returned)"}\n\n` +
      `=== ORIGINAL BRIEF ===\n${prompt}`,
  });
}
