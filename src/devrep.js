import db from "./lib/store.js";
import { emit } from "./lib/bus.js";

/**
 * THE DEVELOPER LEDGER — what this desk remembers about who launched a coin.
 *
 * On-chain forensics loses a serial rugger every single time, and the reason is
 * structural rather than technical: a wallet costs nothing to abandon. Rug, rotate,
 * relaunch, and `serial_deployer` sees a first-time deployer with a clean record.
 *
 * The X account is the one thing they cannot rotate. It carries the followers, and the
 * followers are the entire product — a rugger with no audience is just someone with a
 * failed token. So the handle is the durable identity here, and it is the right key to
 * remember people by.
 *
 * What makes this worth a table rather than a per-workup lookup: the desk pays Grok to
 * research a creator, and then throws the answer away. Every future coin from the same
 * account pays for that research again, and is judged as if it had never been seen.
 * Written down instead, the desk gets strictly harder to fool over time — the second
 * coin from a known rugger is caught for free, and by the fifth the ledger is worth
 * more than the individual reads that built it.
 *
 * Two disciplines the rest of the codebase already follows apply here too:
 *   - A verdict is only ever stored WITH its evidence. "Known rugger" with no sourcing
 *     is gossip, and gossip that kills trades is worse than no memory at all.
 *   - Unknown is never negative. An account we could not find is not an account with
 *     something to hide, and must never be recorded as one.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS dev_reputation (
  handle       TEXT PRIMARY KEY,        -- the X handle, lowercased, no @
  verdict      TEXT NOT NULL,           -- serial_rugger | suspect | clean | unknown
  rug_count    INTEGER NOT NULL DEFAULT 0,
  evidence     TEXT,                    -- how we know; never a bare verdict
  tokens_seen  TEXT NOT NULL DEFAULT '[]',
  first_seen   INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_devrep_verdict ON dev_reputation(verdict);
`);

const norm = (h) => String(h || "").trim().replace(/^@/, "").toLowerCase() || null;

/** What the desk already knows about this handle, if anything. */
export function reputationFor(handle) {
  const h = norm(handle);
  if (!h) return null;
  const r = db.prepare("SELECT * FROM dev_reputation WHERE handle=?").get(h);
  if (!r) return null;
  let tokens = [];
  try { tokens = JSON.parse(r.tokens_seen || "[]"); } catch {}
  return { ...r, tokens };
}

/**
 * Record what an X read found about a creator.
 *
 * Only a SOURCED rugging is remembered as one: `serial_rugger` with no evidence string
 * is downgraded to `suspect`, because a verdict the desk cannot justify later is a
 * verdict it should not act on now. Verdicts only ever escalate — a rugger who behaves
 * on their next launch is still a rugger, and one clean coin must not launder a record.
 */
export function recordDev({ handle, serialRugger, rugEvidence, redFlags = [], symbol, mint, deletedHistory }) {
  const h = norm(handle);
  if (!h) return null;
  const now = Date.now();
  const prior = reputationFor(h);

  const sourced = !!rugEvidence && String(rugEvidence).trim().length > 12;
  let verdict = "unknown";
  if (serialRugger === true) verdict = sourced ? "serial_rugger" : "suspect";
  else if (deletedHistory === true || (redFlags?.length ?? 0) > 0) verdict = "suspect";
  else if (serialRugger === false) verdict = "clean";

  // Escalate only. A rugger's next coin behaving well does not clear the record.
  const RANK = { unknown: 0, clean: 1, suspect: 2, serial_rugger: 3 };
  if (prior && RANK[prior.verdict] >= RANK[verdict]) verdict = prior.verdict;

  const tokens = prior?.tokens ?? [];
  if (symbol && !tokens.some((t) => t.mint === mint))
    tokens.push({ symbol, mint, at: now });

  const evidence = sourced ? String(rugEvidence).slice(0, 600)
    : prior?.evidence ?? (redFlags?.length ? redFlags.join("; ").slice(0, 600) : null);
  const rugCount = Math.max(prior?.rug_count ?? 0, serialRugger === true ? 2 : 0);

  db.prepare(`INSERT INTO dev_reputation (handle,verdict,rug_count,evidence,tokens_seen,first_seen,last_seen)
              VALUES (?,?,?,?,?,?,?)
              ON CONFLICT(handle) DO UPDATE SET
                verdict=excluded.verdict, rug_count=excluded.rug_count,
                evidence=COALESCE(excluded.evidence, dev_reputation.evidence),
                tokens_seen=excluded.tokens_seen, last_seen=excluded.last_seen`)
    .run(h, verdict, rugCount, evidence, JSON.stringify(tokens.slice(-12)),
         prior?.first_seen ?? now, now);

  if (verdict === "serial_rugger" && prior?.verdict !== "serial_rugger")
    emit("dev:flagged", { handle: h, verdict, evidence: evidence?.slice(0, 160), symbol });
  return reputationFor(h);
}

/** Everyone the desk has written off, most recently seen first. */
export const knownRuggers = (limit = 50) =>
  db.prepare("SELECT * FROM dev_reputation WHERE verdict='serial_rugger' ORDER BY last_seen DESC LIMIT ?")
    .all(limit);

export const ledgerSize = () =>
  db.prepare("SELECT COUNT(*) n FROM dev_reputation").get().n;
