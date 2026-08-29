/**
 * THE WORLD DIRECTOR — the server runs the office, the clients only watch it.
 *
 * The ambient life on a floor (errands, desk business, snack-room arguments,
 * throwaway chatter) used to be client-side dice: every visitor watched a
 * different office. Now one director rolls the dice here and broadcasts the
 * result, so two people looking at the same floor see the same person walk to
 * the same shredder saying the same line at the same moment — and because every
 * emit is chronicled, the office's whole day is on the record like everything
 * else.
 *
 * The events are semantic, not positional: the client owns coordinates, lines
 * and animation. The server only says WHO does WHAT and WHICH line — indexes
 * into tables the client already ships. That keeps this file free of any
 * knowledge of the room's geometry.
 */
import { emit } from "./lib/bus.js";

const SEATS = ["Scout", "Screener", "Forensics", "Liquidity", "Flow", "Technical",
  "Narrative", "Red Team", "Risk", "PM", "Execution", "Compliance", "Scribe"];

// Client-side table sizes, mirrored here so an index is never out of range.
// If a table grows on the client, grow the constant — an index too large is
// clamped there anyway, but the variety would silently shrink.
const ROUTINE_LINES = 3, TASK_LINES = 3, CHATTER_LINES = 8, SNACK_SCRIPTS = 8;

let timer = null;

export function startWorld() {
  if (timer) return;
  if (process.env.WORLD_ENABLED === "0") { console.log("[world] disabled"); return; }

  const rnd = Math.random;   // ambience needs no reproducibility, only agreement
  const tick = () => {
    const roll = rnd();
    if (roll < 0.28) {
      // two agents take a break together and have the same argument everywhere
      const a = SEATS[(rnd() * SEATS.length) | 0];
      let b = SEATS[(rnd() * SEATS.length) | 0];
      if (b === a) b = SEATS[(SEATS.indexOf(a) + 1) % SEATS.length];
      emit("world:snack", { a, b, ti: (rnd() * SNACK_SCRIPTS) | 0 });
    } else {
      const seat = SEATS[(rnd() * SEATS.length) | 0];
      const r2 = rnd();
      if (r2 < 0.35) emit("world:act", { seat, kind: "errand", li: (rnd() * ROUTINE_LINES) | 0 });
      else if (r2 < 0.75) emit("world:act", { seat, kind: "task", li: (rnd() * TASK_LINES) | 0 });
      else emit("world:act", { seat, kind: "chat", li: (rnd() * CHATTER_LINES) | 0 });
    }
    timer = setTimeout(tick, 4500 + rnd() * 5500);
  };
  timer = setTimeout(tick, 3000);
  console.log("[world] the server runs the office");
}
