/**
 * COLONEL DEBRIEF — the Review seat. Grades every landing.
 *
 * The Scribe records what the desk said; nobody was reading it back. Every
 * closed call now gets a post-mortem: what the thesis claimed, what actually
 * happened, and the one transferable lesson — written for the PM, who reads
 * the last few before every proposal. This is the desk's only feedback loop,
 * which makes it the only mechanism here that can compound.
 *
 * Runs once per CLOSED call — rare by construction — on the mid-tier model at
 * low effort. A post-mortem that fails is logged and skipped; the books never
 * wait on the coach.
 */
import { z } from "zod";
import db from "../lib/store.js";
import { ask } from "../lib/llm.js";
import { emit } from "../lib/bus.js";
import { highWaterMark } from "../calls.js";

db.exec(`
CREATE TABLE IF NOT EXISTS lessons (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id   INTEGER NOT NULL REFERENCES calls(id),
  symbol    TEXT,
  grade     TEXT,
  lesson    TEXT NOT NULL,
  ts        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lessons_ts ON lessons(id DESC);
`);

const DebriefOut = z.object({
  grade: z.enum(["good_call", "bad_call", "good_process_bad_luck", "bad_process_good_luck"]),
  what_happened: z.string(),
  lesson: z.string().describe("one transferable sentence the PM should carry into the next decision"),
});

export async function runDebrief(call) {
  const movePct = call.entry_ref && call.close_mark
    ? ((call.close_mark - call.entry_ref) / call.entry_ref) * 100 : null;
  const hwm = highWaterMark(call.id);
  const peakPct = call.entry_ref && hwm ? ((hwm - call.entry_ref) / call.entry_ref) * 100 : null;

  try {
    const out = await ask({
      seat: "Review",
      model: process.env.DESK_MODEL_REVIEW || "claude-sonnet-5",
      effort: "low",
      schema: DebriefOut,
      maxTokens: 6000,
      system: `You are the REVIEW seat — the desk's post-mortem officer. One closed call,
one debrief, one transferable lesson.

Grade the PROCESS, not the outcome: a call that followed a sound thesis and lost is
good_process_bad_luck; a winner whose thesis was wrong is bad_process_good_luck. The
lesson must be one sentence a portfolio manager can actually apply to the NEXT
decision — a pattern, a tell, a timing rule — never a platitude ("be careful") and
never a restatement of what happened.`,
      prompt:
        `CLOSED CALL — ${call.symbol} (${call.category})\n` +
        `thesis: ${call.thesis || "(none recorded)"}\n` +
        `invalidation: ${call.invalidation || "(none recorded)"}\n` +
        `entry ${call.entry_ref} · stop ${call.stop} · target ${call.target ?? "none"}\n` +
        `held ${(Math.round((call.closed_at - call.opened_at) / 3.6e6))}h · ` +
        `peak ${peakPct != null ? peakPct.toFixed(1) + "%" : "unknown"} · ` +
        `closed at ${call.close_mark} (${movePct != null ? movePct.toFixed(1) + "%" : "?"}) ` +
        `via ${call.close_reason}`,
    });
    db.prepare("INSERT INTO lessons (call_id, symbol, grade, lesson, ts) VALUES (?,?,?,?,?)")
      .run(call.id, call.symbol, out.grade, out.lesson, Date.now());
    emit("seat:verdict", { seat: "Review", symbol: call.symbol, detail: out.grade });
    emit("lesson", { symbol: call.symbol, grade: out.grade, lesson: out.lesson });
    return out;
  } catch (e) {
    emit("seat:failed", { seat: "Review", error: String(e.message || e) });
    return null;
  }
}

/** The PM's reading: the last few lessons, newest first. */
export function recentLessons(n = 5) {
  return db.prepare("SELECT symbol, grade, lesson FROM lessons ORDER BY id DESC LIMIT ?").all(n);
}
