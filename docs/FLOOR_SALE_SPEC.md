<!-- Produced by a design + adversarial-review pass: three independent designs for the
     floor sale, each attacked by a dedicated red team, then consolidated. The attack
     table in section 1 is the reason this design looks the way it does. -->

# Claude Tower — Floor Sale Specification `CTWR-CREDIT-V1`

**Status:** buildable as written. Node ESM + Express + `node:sqlite` + read-only Solana RPC on Render.

---

## 1. CHOSEN APPROACH

**A hybrid built on the *credit ledger* of `signature-claim`, with the *balance-delta verifier* of all three, the *derived-and-pinned treasury* of `reference-memo`, and — decisively — **no reservations, no per-floor deposit addresses, and no server-composed transactions.**

Two facts are kept strictly separate and are never made atomic (they cannot be):

1. **Money arrived.** A verified inbound USDC transfer to a treasury-owned token account becomes a **credit** in base units, owned by the wallet that owns the *debited* token account. Written **only** by the server's own treasury scanner.
2. **A floor was allocated.** The credit's owner spends 50 USDC of credit on an available floor. Pure database transaction, no RPC, instant.

### What this closes that the others do not

| Attack (source design) | Why it is gone here |
|---|---|
| **F1 dust-lock (reference-memo)** — 1 base unit permanently un-expires an intent, `ux_intent_live_floor` then makes the floor unquotable forever; ~$0.50 kills all 49 floors | There is no intent and no floor-scoped lock. A dust payment produces a 0.000001 USDC credit and touches nothing else. Structural, not a patch: **nothing in this design can hold a floor except an allocated purchase.** |
| **F2 free reservation lockout (reference-memo *and* deterministic-ata)** — free wallets take exclusive reservations on all 49 floors forever, zero cost | No reservations. `POST /allocate` requires ≥50 USDC of *spendable credit*, which requires 50 USDC to have irreversibly landed in the treasury. **The cheapest denial-of-sale is now 50 USDC per floor, and it buys the attacker the floor.** |
| **F4 expiry-window snipe (reference-memo) / S1 front-run the reserved floor (deterministic-ata)** — the public `reservedUntil` field is a targeting oracle; the victim's in-flight 50 USDC becomes an unrefundable orphan | There is no `reservedUntil` to publish and no window between "paid" and "released". A buyer beaten to floor 12 keeps 100% of their credit and spends it on another floor in one call. **This is the only losing-race outcome across the three designs that does not end at a manual refund.** |
| **FATAL 1 signer ≠ payer (signature-claim)** — a relayer or SPL delegate co-signs the victim's transfer and claims the floor for 5,000 lamports | Credit is issued to the **owner of the debited token account**, computed from `pre/postTokenBalances`. The signer set and the fee payer are recorded and *never* used for entitlement. A relayer who pays the fee gives the victim credit. A delegate who spends the victim's USDC gives the victim credit. |
| **FATAL 2/3 + S5 RPC amplification (signature-claim)** — a free keypair + a random base58 string forces three archival `searchTransactionHistory` calls; drains the RPC plan, closes the sale, flips that day's floors to `disputed`, and permanently caches honest buyers' claims as `E_TX_NOT_FOUND` | **No user-facing endpoint performs RPC.** `/allocate` is a pure DB read/write. `/nudge` reorders the scanner's work queue and issues zero calls of its own. RPC volume is a function of *treasury inbound transactions*, not of HTTP traffic. `E_TX_NOT_FOUND` does not exist as a user-facing state because no user ever submits a signature for verification. |
| **F1 blind-signed sweeps (deterministic-ata)** — the server composes base64 transactions the owner approves on a Ledger; a compromised server emits `SetAuthority` and owns all future revenue | **No endpoint in this spec ever returns a transaction, signed or unsigned.** Enforced by a lint rule and a boot assertion: `Keypair`, `Transaction`, `VersionedTransaction`, `sendTransaction`, `simulateTransaction` must not appear in the server bundle. Money lands directly in the owner's existing ATA; there is nothing to sweep. |
| **S5 pre-funding brick (deterministic-ata)** — 49 lamports sent to computable `createWithSeed` addresses before launch makes `createAccountWithSeed` fail permanently | No derived accounts are ever created. |
| **S2 one-tx-many-floors is unrecordable (deterministic-ata)** — `signature` as PK silently drops the second 50 USDC | Credits are keyed `(signature, dest_token_account)` and denominated in base units. 100 USDC in one transaction is one 100-USDC credit that buys two floors. |
| **S3 attacker-writable `orphan` status (deterministic-ata) / S2 claim poison pill (reference-memo)** — a stranger's HTTP call corrupts or permanently blocks your settled payment | No user-triggered path can create, mutate, or observe-into-existence a credit row. The scanner is the only writer. |
| **S8 per-signature credit (signature-claim)** — two 25-USDC payments are two independent `E_UNDERPAID` terminals; 50 USDC lost | Credit is **wallet-scoped**. Two 25-USDC payments sum to 50 and buy a floor. There is no per-signature price test anywhere. |
| **S7 retroactive price confiscation (signature-claim)** | Credits are USDC-denominated and carry `price_snapshot`. Allocation charges `MIN(current_price, best snapshot among the wallet's spendable credits)`. A price rise can never strand a paid buyer. |
| **FATAL 4 no void path (signature-claim)** — the owner hand-refunds and the buyer keeps the floor and the money | `POST /admin/floors/:n/reclaim` requires a `refundSignature`, voids the purchase, returns the floor to `available`, and writes `ownership_events`. |
| **S4 ALT/v0 index resolution (reference-memo, deterministic-ata)** — `accountKeys.findIndex` returns −1 for lookup-table transactions, silently rejecting every smart-wallet, Squads and aggregator payment | The destination is identified by the token-balance entry's **own `owner` + `mint` + `programId` fields**, which do not depend on index resolution at all. Index resolution is a corroborating log line, never load-bearing. |
| **S1 enumerable memo (reference-memo) / S10 nonce as bearer secret (deterministic-ata)** | There is no reference key and no routing memo. Attribution is the debited-account owner. A memo, if present, is stored for support and routes nothing. |

**What this design gives up, honestly:** you cannot hold a specific floor. If you want floor 13 and someone allocates it four seconds before you do, you have 50 USDC of credit and 48 other floors. Every alternative examined bought "floor 13 is yours for 30 minutes" at the price of a free, permanent, aimed lockout of the entire building. That trade is not worth making for a 2,450 USDC one-time sale.

---

## 2. SCHEMA

`node:sqlite`, one file on a Render **persistent disk**, one process, one writer.

```js
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  PRAGMA synchronous = FULL;
`);
```

`synchronous = FULL`: a lost WAL frame is a lost ownership record for money that is irreversibly on chain. Write rate is a few per day; the fsync cost is irrelevant.

```sql
-- ============================================================ config
CREATE TABLE IF NOT EXISTS tower_config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;
-- keys: treasury_owner, treasury_ata, usdc_mint, token_program, usdc_decimals,
--       price_base_units, sale_open_slot, sale_state('open'|'paused'|'closed'),
--       max_floors_per_wallet, maturity_slots, min_credit_base_units, schema_version

-- ============================================================ floors
CREATE TABLE IF NOT EXISTS floors (
  floor_no       INTEGER PRIMARY KEY CHECK (floor_no BETWEEN 1 AND 50),
  status         TEXT NOT NULL DEFAULT 'available'
                   CHECK (status IN ('available','owned','flagged','withheld')),
  owner_wallet   TEXT,
  purchase_id    INTEGER REFERENCES purchases(id),
  owner_since    INTEGER,
  display_name   TEXT,
  desk_config    TEXT,                    -- JSON: the 14-agent desk layout
  desk_seeded_at INTEGER,
  updated_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  -- an owned or flagged floor has an owner; available and withheld never do
  CHECK ((status IN ('owned','flagged')) = (owner_wallet IS NOT NULL)),
  -- Floor 50 is not for sale. Enforced by the database, on INSERT and UPDATE,
  -- including via the admin grant path.
  CHECK (floor_no <> 50 OR status = 'withheld')
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_floors_purchase
  ON floors(purchase_id) WHERE purchase_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_floors_owner
  ON floors(owner_wallet) WHERE owner_wallet IS NOT NULL;

-- ============================================================ credits  (MONEY)
-- One row per (transaction, treasury token account credited). Written ONLY by
-- the treasury scanner. No HTTP handler inserts, updates or deletes here except
-- the two admin routes in §6.
CREATE TABLE IF NOT EXISTS credits (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  signature           TEXT    NOT NULL,
  dest_token_account  TEXT    NOT NULL,     -- resolved treasury-owned USDC account
  payer_wallet        TEXT,                 -- owner of the debited USDC account
  mint                TEXT    NOT NULL,
  treasury_owner      TEXT    NOT NULL,
  credited_base_units INTEGER NOT NULL CHECK (credited_base_units > 0),
  consumed_base_units INTEGER NOT NULL DEFAULT 0 CHECK (consumed_base_units >= 0),
  voided_base_units   INTEGER NOT NULL DEFAULT 0 CHECK (voided_base_units  >= 0),
  price_snapshot      INTEGER NOT NULL,     -- price in force when this credit was written
  slot                INTEGER NOT NULL,
  block_time          INTEGER,              -- advisory only, never a bound
  status              TEXT NOT NULL DEFAULT 'spendable'
                        CHECK (status IN ('spendable','unattributed','contradicted','voided')),
  quorum_json         TEXT NOT NULL,        -- ["helius","triton"]
  facts_json          TEXT NOT NULL,        -- the frozen checked tuple, for audit
  raw_json_a          TEXT NOT NULL,        -- getTransaction from agreeing provider #1
  raw_json_b          TEXT NOT NULL,        -- ...and #2. Store both or neither.
  memo                TEXT,                 -- support only; routes nothing
  verified_at         INTEGER NOT NULL DEFAULT (unixepoch()),
  last_recheck_at     INTEGER,
  recheck_count       INTEGER NOT NULL DEFAULT 0,
  reattributed_from   TEXT,                 -- prior payer_wallet, if an admin reassigned
  -- ===== THE LEDGER INVARIANT: you can never spend more than arrived. =====
  CHECK (consumed_base_units + voided_base_units <= credited_base_units),
  CHECK (payer_wallet IS NOT NULL OR status IN ('unattributed','voided'))
) STRICT;

-- ===== "ONE PAYMENT CREDITS ONCE" — enforced by the database, not by code. =====
CREATE UNIQUE INDEX IF NOT EXISTS ux_credits_sig_dest
  ON credits(signature, dest_token_account);

CREATE INDEX IF NOT EXISTS ix_credits_spendable
  ON credits(payer_wallet, verified_at) WHERE status = 'spendable';
CREATE INDEX IF NOT EXISTS ix_credits_recheck
  ON credits(last_recheck_at) WHERE status IN ('spendable','unattributed');

-- ============================================================ purchases (OWNERSHIP)
CREATE TABLE IF NOT EXISTS purchases (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  floor_no         INTEGER NOT NULL REFERENCES floors(floor_no),
  buyer_wallet     TEXT    NOT NULL,
  price_base_units INTEGER NOT NULL CHECK (price_base_units > 0),
  status           TEXT    NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','reclaimed')),
  idempotency_key  TEXT,
  created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  reclaimed_at     INTEGER,
  reclaim_reason   TEXT,
  refund_signature TEXT,                 -- the owner's own return tx, pasted by hand
  CHECK (status = 'active' OR refund_signature IS NOT NULL)
) STRICT;

-- ===== "ONE FLOOR, ONE LIVE PURCHASE" — the race backstop. =====
CREATE UNIQUE INDEX IF NOT EXISTS ux_purchase_active_floor
  ON purchases(floor_no) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS ix_purchases_wallet ON purchases(buyer_wallet);

-- ============================================================ credit_debits
-- The double-entry link. A purchase draws from one or more credits; the sum of
-- debits against a credit can never exceed what arrived (enforced by the CHECK
-- on credits, fired through the triggers below).
CREATE TABLE IF NOT EXISTS credit_debits (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  credit_id         INTEGER NOT NULL REFERENCES credits(id),
  purchase_id       INTEGER NOT NULL REFERENCES purchases(id),
  amount_base_units INTEGER NOT NULL CHECK (amount_base_units > 0),
  created_at        INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_debit_credit_purchase
  ON credit_debits(credit_id, purchase_id);
CREATE INDEX IF NOT EXISTS ix_debit_purchase ON credit_debits(purchase_id);

-- consumed_base_units is maintained by the database so it can never drift from
-- the debit rows, and the credits CHECK aborts any overspend at commit time.
CREATE TRIGGER IF NOT EXISTS trg_debit_ins AFTER INSERT ON credit_debits
BEGIN
  UPDATE credits SET consumed_base_units = consumed_base_units + NEW.amount_base_units
   WHERE id = NEW.credit_id;
END;
CREATE TRIGGER IF NOT EXISTS trg_debit_del AFTER DELETE ON credit_debits
BEGIN
  UPDATE credits SET consumed_base_units = consumed_base_units - OLD.amount_base_units
   WHERE id = OLD.credit_id;
END;
CREATE TRIGGER IF NOT EXISTS trg_debit_no_update
BEFORE UPDATE ON credit_debits
BEGIN
  SELECT RAISE(ABORT, 'credit_debits_is_append_only');
END;

-- ============================================================ idempotency
CREATE TABLE IF NOT EXISTS allocation_requests (
  key         TEXT    NOT NULL,
  wallet      TEXT    NOT NULL,
  floor_no    INTEGER NOT NULL,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id),
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (key, wallet)
) STRICT;

-- ============================================================ scanner state
CREATE TABLE IF NOT EXISTS scan_state (
  token_account   TEXT PRIMARY KEY,   -- a treasury-owned USDC account
  cursor_sig      TEXT,               -- newest FULLY PROCESSED signature (see §5.4)
  last_pass_at    INTEGER,
  last_pass_ok    INTEGER NOT NULL DEFAULT 1,
  backlog_est     INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;

CREATE TABLE IF NOT EXISTS scan_queue (          -- the priority lane for /nudge
  signature   TEXT PRIMARY KEY,
  wallet      TEXT NOT NULL,
  enqueued_at INTEGER NOT NULL DEFAULT (unixepoch()),
  attempts    INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX IF NOT EXISTS ix_queue_order ON scan_queue(enqueued_at);

CREATE TABLE IF NOT EXISTS provider_health (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  tag            TEXT NOT NULL,       -- 'a' | 'b' | 'c'
  observed_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  finalized_slot INTEGER,
  latency_ms     INTEGER,
  ok             INTEGER NOT NULL,
  error_text     TEXT
) STRICT;

-- ============================================================ audit
CREATE TABLE IF NOT EXISTS ownership_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         INTEGER NOT NULL DEFAULT (unixepoch()),
  event      TEXT NOT NULL,   -- credit|allocate|reclaim|grant|flag|unflag|void|attribute
  floor_no   INTEGER,
  wallet     TEXT,
  signature  TEXT,
  credit_id  INTEGER,
  purchase_id INTEGER,
  actor      TEXT NOT NULL,   -- 'scanner' | 'buyer' | 'admin'
  detail     TEXT
) STRICT;
CREATE TRIGGER IF NOT EXISTS trg_events_append_only
BEFORE UPDATE ON ownership_events
BEGIN SELECT RAISE(ABORT, 'ownership_events_is_append_only'); END;
CREATE TRIGGER IF NOT EXISTS trg_events_no_delete
BEFORE DELETE ON ownership_events
BEGIN SELECT RAISE(ABORT, 'ownership_events_is_append_only'); END;

-- ============================================================ seed
INSERT OR IGNORE INTO floors (floor_no, status, display_name)
SELECT v, CASE WHEN v = 50 THEN 'withheld' ELSE 'available' END,
          CASE WHEN v = 50 THEN 'Headquarters' ELSE NULL END
FROM (WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v+1 FROM n WHERE v < 50)
      SELECT v FROM n);
```

### The four database-level guarantees

| Guarantee | Enforced by |
|---|---|
| One on-chain transaction credits at most once per destination account | `ux_credits_sig_dest` |
| A wallet can never allocate more floors than its money covers | `CHECK (consumed + voided <= credited)` on `credits`, driven by the `credit_debits` triggers |
| A floor has at most one live purchase, ever | `ux_purchase_active_floor` (partial UNIQUE) |
| A floor row points at one purchase, and floor 50 can never be sold | `ux_floors_purchase` + `CHECK (floor_no <> 50 OR status = 'withheld')` |

---

## 3. PURCHASE FLOW

**Signing wallets are named at every step. Exactly one transaction is ever signed in this system, and it is signed by the buyer, in the buyer's own wallet.**

| # | Actor | Action | Who signs |
|---|---|---|---|
| 0 | **Owner**, once, before launch | Ensures the treasury's canonical USDC ATA exists (fund it with any dust amount, or `createAssociatedTokenAccount` from their own wallet). Publishes `TREASURY_OWNER` on the marketing homepage and in `/tower-manifest.json`. Sets `sale_open_slot` to the current finalized slot. | Owner's wallet — **and only if the ATA does not already exist**. Nothing the server composed. |
| 1 | Server, boot | Derives `TREASURY_ATA`, verifies it on chain, enumerates every treasury-owned USDC token account, runs the provider compatibility probe (§8.5). Any failure → `sale_state = 'paused'`, reads still serve. | — |
| 2 | Buyer | `POST /api/tower/auth/nonce` → Phantom `signMessage` over the domain-bound challenge → `POST /api/tower/auth/verify` → HttpOnly session cookie bound to `wallet`. | **Buyer's wallet, a message only.** No transaction, no money. |
| 3 | Buyer | `GET /api/tower/config` and `GET /api/tower/floors`. The client **re-derives** `TREASURY_ATA` from constants baked into its own bundle and **refuses to proceed** if the server's value differs. The address is displayed for manual comparison against the homepage. | — |
| 4 | Buyer | Sends **50.000000 USDC** (`50000000` base units) to `TREASURY_ATA`. Either via the Tower "Pay" button (which builds an unsigned `createTransferCheckedInstruction(buyerUsdcAta, USDC_MINT, TREASURY_ATA, buyerPubkey, 50_000_000n, 6)` **in the browser, from client-side constants**) or from Phantom's own send screen, or a script, or any wallet. | **Buyer's wallet signs and submits.** The server never sees a key, never builds a signed transaction, never calls `sendTransaction`. Money moves buyer → treasury, one hop, no intermediary. |
| 5 | Buyer *(optional)* | `POST /api/tower/nudge { signature }`. Puts the signature in the scanner's **priority lane**. This endpoint performs **zero RPC of its own**. Skipping it costs latency only. | — |
| 6 | Server, scanner | Discovers the transaction on the treasury account, runs the §4 checklist against 2-of-3 archival providers, and writes a `credits` row owned by the **debited token account's owner**. Typically 15–45 s after finality. **A buyer who closes the tab still gets credited.** | — |
| 7 | Buyer | `GET /api/tower/me` shows `credit.availableBaseUnits: "50000000"`. | — |
| 8 | Buyer | `POST /api/tower/allocate { floorNo: 12 }` with an `Idempotency-Key` header. One `BEGIN IMMEDIATE`, no RPC: debit credit → flip floor → insert purchase → link debits → append event → commit. Response `201` with the deed. | — |
| 9 | Server | Seeds the 14 agent desks for floor 12, stamps `desk_seeded_at`. Idempotent, keyed on `purchases.id`; a crash between commit and provisioning is repaired by the next boot sweep. | — |
| 10 | Server, recheck job | Re-verifies each credit at +10 m, +1 h, +6 h, +24 h, +7 d (§5.5). | — |
| 11 | **Owner**, whenever | Spends from the treasury normally. Refunds are sent by hand from the owner's own wallet and recorded via `/admin/.../reclaim` or `/admin/credits/:id/void`. | Owner's wallet, on a transaction the owner composed themselves. |

The gap between step 4 and step 6 is the entire risk surface of any non-custodial design. It is 15–45 s here, it is stated in the UI, and §7 says what it still cannot fix.

---

## 4. VERIFICATION CHECKLIST

Run by the **scanner only**, per candidate signature, before a single base unit of credit exists. Every check names the attack it closes. `RPC_QUORUM = 2` of 3 independent **archival** providers, distinct companies, read-only API keys.

### V0 — Quorum, with abstention ≠ denial

≥2 providers must return a **non-null** `getTransaction` at `commitment:'finalized'` and agree byte-for-byte on the extracted fact tuple
`{ signature, slot, err, treasuryDeltaBaseUnits, destAccounts[], payerOwner, mint, programId, decimals }`.

- A provider returning `null`, an error, a timeout, or a 429 **abstains**. It never casts a "does not exist" vote.
- Fewer than 2 affirmative agreeing votes → **no state change at all**, retry with backoff, alert if it persists past 15 min.
- 2 affirmative votes that **disagree** on any tuple field → `ownership_events(event='flag')`, no credit, page the owner. This is a security event.

> Closes signature-claim **S5** (a transient non-archival failover permanently caching a paid buyer's claim as terminal), **FATAL 3** (exhausted providers fabricating disputes across every floor sold that day), and reference-memo **§6.6**. The design's own posture: **a degraded RPC layer delays credits. It never rejects, never disputes, and never closes the site.** `GET /floors`, `GET /me` and `POST /allocate` keep working from the database throughout.

### V1 — `tx !== null`
Distinguishes "not yet visible" from "never happened". *Closes: crediting on absence of evidence.*

### V2 — `tx.transaction.signatures[0] === candidateSignature`
*Closes: a provider echoing a different transaction than the one requested (signature-claim `E_SIG_MISMATCH`).*

### V3 — `tx.meta.err === null`
*Closes: a failed transaction moved no tokens; crediting one is free money.*

### V4 — Finality + maturity: `tx.slot <= finalizedSlot - MATURITY_SLOTS` (`MATURITY_SLOTS = 32`)
Fetched at `commitment:'finalized'` on both agreeing providers. `processed` and `confirmed` are never accepted.
*Closes: crediting a transaction that has not been rooted; shallow-confirmation reversal.*

### V5 — Sale window in **slots**: `tx.slot >= sale_open_slot`
*Closes: dredging up an old, unrelated payment to the treasury and claiming it as a purchase (deterministic-ata **S6**, whose late path had no slot bound at all; signature-claim `E_TX_BEFORE_SALE`).*

### V6 — Destination set, identified by its own fields, not by index

```js
const T = tx.meta.postTokenBalances.filter(b =>
  b.owner     === TREASURY_OWNER &&                       // (a) destination OWNER
  b.mint      === USDC_MINT      &&                       // (b) mint
  b.programId === TOKEN_PROGRAM_ID                        // (c) token program
);
if (T.length === 0) return REJECT('no_treasury_credit');
```

- **(a) `owner === TREASURY_OWNER`** — proves the money landed **under the owner's authority**, not merely at an address that resembles the ATA. *Closes: a lookalike destination; the whole class deterministic-ata called "destination authority pinned".*
- **(b) `mint === EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`** — *closes: paying in a worthless SPL token with the symbol "USDC".*
- **(c) `programId === TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`** — *closes: a **Token-2022** lookalike mint, which can render as "USDC" in a wallet and can carry transfer fees or a permanent delegate. This project's own $CHIKI is Token-2022; the mistake is live in the codebase's history.*

**Deliberately not used:** `accountKeys.findIndex(k => k.pubkey === TREASURY_ATA)`. *Closes reference-memo **S4** and deterministic-ata's sibling: for a v0 transaction whose destination arrives via an address-lookup-table, `findIndex` returns `-1`, the delta computes as `0n`, and every Squads / smart-wallet / aggregator payment is silently rejected into the manual queue.* The resolved-index address is computed where possible and **logged as corroboration only**; failure to resolve it is not fatal.

### V7 — `decimals === 6` on every entry in `T`
*Closes: a provider or a spoofed mint misreporting denomination, turning 50 base units into "50 USDC".*

### V8 — Amount: **summed** delta across all treasury-owned entries, BigInt, base units

```js
const pre = new Map(tx.meta.preTokenBalances.map(b => [b.accountIndex, b]));
let delta = 0n;
for (const post of T) {
  const p = pre.get(post.accountIndex);
  if (p && (p.mint !== post.mint || p.owner !== post.owner)) return REJECT('account_reused');
  delta += BigInt(post.uiTokenAmount.amount) - BigInt(p?.uiTokenAmount.amount ?? '0');
}
if (delta < MIN_CREDIT_BASE_UNITS) return REJECT('below_min_credit');
```

- **Summed, not per-entry.** *Closes: a transaction that moves 50 USDC from one treasury-owned account to another, which nets to zero and must credit nothing.*
- **`uiTokenAmount.amount`, a decimal string, parsed with `BigInt`.** `uiAmount` and `uiAmountString` are floats and are read **nowhere in this system**. *Closes: 50 USDC is `50000000`, not `50.0`.*
- **`pre` absent → 0** is correct here and only here, because a buyer legitimately may create a treasury-owned token account inside their own transaction; V6(a) already proves the authority. The paired mint/owner identity check above closes the account-reuse variant.
- **Verification is by balance delta, never by instruction parsing.** *Closes: `transfer` vs `transferChecked`, CPI from a router or smart wallet, inner instructions, decoy instructions, multi-hop swaps ending in USDC, and Token-2022 transfer-fee deduction — the delta is measured at the destination after everything.*

### V9 — Payer attribution: **owner of the debited account**, never the signer, never the fee payer

```js
const byOwner = new Map();                       // net USDC delta grouped by token-account owner
for (const post of allUsdcPostBalances) {
  const p = preByIndex.get(post.accountIndex);
  const d = BigInt(post.uiTokenAmount.amount) - BigInt(p?.uiTokenAmount.amount ?? '0');
  byOwner.set(post.owner, (byOwner.get(post.owner) ?? 0n) + d);
}
for (const p of onlyInPre) { /* accounts closed in-tx: subtract their pre balance */ }
const debited = [...byOwner].filter(([o, d]) => d < 0n && o !== TREASURY_OWNER);
if (debited.length !== 1) return UNATTRIBUTED();  // 0 or 2+ → operator queue, no spendable credit
const payer_wallet = debited[0][0];
```

*Closes signature-claim **FATAL 1** — the single most valuable finding in the whole review. A relayer offering "gasless Tower payments", or anyone holding an SPL `Approve` delegation on the victim's USDC account, is a legitimate **signer** of the victim's transfer. Under a signer-based rule they claim the floor for 5,000 lamports and permanently burn the victim's payment. Here the signer set and `accountKeys[0]` are recorded in `facts_json` and confer **nothing**. Also closes deterministic-ata **S6** (the late path granting to the fee payer) and **M3** (multi-source transfers undefined — here they are explicitly `unattributed`, never guessed at).*

### V10 — `payer_wallet !== TREASURY_OWNER`
*Closes: the owner's own internal transfers minting spendable credit.*

### V11 — `blockTime` recorded, **advisory only**
Present in `facts_json` and in API responses. It is a validator estimate and can be minutes off. **No decision in this system is gated on it.** Every hard bound is in slots (V4, V5).
*Closes: deterministic-ata §7.8 / reference-memo check 10 — a wall-clock bound rejecting a genuine payment because a node's clock estimate drifted.*

### V12 — Idempotent write, scanner-exclusive

```sql
INSERT INTO credits (...) VALUES (...) ON CONFLICT(signature, dest_token_account) DO NOTHING;
```

*Closes reference-memo **S2** (the `/claim` poison pill — a stranger's HTTP call creating a non-credited row for your signature so your real settlement hits `SQLITE_CONSTRAINT` and no-ops) and deterministic-ata **S3** (a stranger's claim stamping `orphan` onto your already-applied payment). Structurally, not by patching a branch: **no HTTP handler can create, mutate, or infer a credit row.** Idempotency is keyed on the credited row's existence, and only the scanner can produce one.*

### What is deliberately NOT checked

- **No Solana Pay `reference` key.** *Closes reference-memo **§6.8** (a stranger scraping your public reference and attaching it to their own transfer) and the QR-photograph disclosure.*
- **No routing memo.** A memo, if present, is stored in `credits.memo` for support and **routes nothing**. *Closes reference-memo **S1** — a `CTWR-F12-0000841` memo tag carrying ~10 bits of entropy as a secondary routing key against a design that assumed 256.*
- **No reservation nonce.** *Closes deterministic-ata **S10**.*

---

## 5. RACE + REORG HANDLING

### 5.1 The transaction discipline (non-negotiable)

```js
// db.js — the ONLY way any write reaches SQLite.
export function withTx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  let out;
  try {
    out = fn();                                  // fn MUST be synchronous
    if (out && typeof out.then === 'function') { // a Promise here is a correctness bug
      throw new Error('withTx: async work inside a transaction');
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
  return out;
}
```

`node:sqlite` transactions are **per-connection, not per-request**. A single `await` between `BEGIN IMMEDIATE` and `COMMIT` lets a concurrent handler's statements execute *inside* your transaction and be committed or rolled back with it — every race guard in this document then evaporates silently, with a double-granted floor and no error. *This closes reference-memo **S5**, which is an implementation-drift risk rather than a design bug, and the enforced boundary is the only thing that makes it stay closed through future refactors.* All RPC happens **before** `withTx` is called. There is a second, read-only connection for `GET` handlers.

### 5.2 Allocation — the exact transaction

```js
const result = withTx(db, () => {
  const cfg = readConfig(db);
  if (cfg.sale_state !== 'open') throw http(409, 'E_SALE_NOT_OPEN');   // the kill switch is READ

  // Idempotent replay: the single most common real-world event is a dropped response.
  const prev = qPrevRequest.get(idemKey, wallet);
  if (prev) return { replay: true, ...loadPurchase(db, prev.purchase_id) };

  const credits = qSpendable.all(wallet);   // ORDER BY verified_at ASC, id ASC  (FIFO)
  const available = credits.reduce((a, c) => a + c.avail, 0n);

  // Price honours the buyer's quote: a rise can never confiscate an existing credit.
  const bestSnapshot = credits.reduce((m, c) => c.price_snapshot < m ? c.price_snapshot : m,
                                      cfg.price_base_units);
  const price = bestSnapshot < cfg.price_base_units ? bestSnapshot : cfg.price_base_units;

  if (available < price) throw http(409, 'E_INSUFFICIENT_CREDIT',
                                   { availableBaseUnits: String(available),
                                     requiredBaseUnits:  String(price) });

  const owned = qCountActive.get(wallet).n;
  if (owned >= cfg.max_floors_per_wallet) throw http(409, 'E_WALLET_FLOOR_LIMIT');

  // ===== GUARD 1: the conditional UPDATE. changes() is the authority. =====
  const upd = qClaimFloor.run(wallet, floorNo);   // ... WHERE floor_no=? AND status='available'
  if (upd.changes !== 1) {
    const f = qFloor.get(floorNo);
    if (!f)                       throw http(404, 'E_NO_SUCH_FLOOR');
    if (f.status === 'withheld')  throw http(409, 'E_FLOOR_NOT_FOR_SALE');   // floor 50
    throw http(409, 'E_FLOOR_TAKEN', { status: f.status });                  // credit UNTOUCHED
  }

  // ===== GUARD 2: ux_purchase_active_floor aborts if guard 1 was ever bypassed. =====
  const pid = qInsertPurchase.run(floorNo, wallet, price, idemKey).lastInsertRowid;

  // ===== GUARD 3: the credits CHECK, fired through the credit_debits triggers. =====
  let need = price;
  for (const c of credits) {
    if (need === 0n) break;
    const take = c.avail < need ? c.avail : need;
    qInsertDebit.run(c.id, pid, take);          // trigger bumps consumed; CHECK aborts overspend
    need -= take;
  }
  if (need !== 0n) throw new Error('invariant: debit shortfall');   // rolls the whole thing back

  qLinkFloorPurchase.run(pid, floorNo);
  qInsertIdem.run(idemKey, wallet, floorNo, pid);
  appendEvent(db, { event: 'allocate', floor_no: floorNo, wallet, purchase_id: pid, actor: 'buyer' });
  return { replay: false, ...loadPurchase(db, pid) };
});
```

**Two buyers race for floor 12.** Both hold 50 USDC of real credit. `BEGIN IMMEDIATE` serialises them on the single writer. The first `UPDATE` reports `changes === 1` and wins. The second reports `0`, **rolls back without consuming a single base unit of credit**, and returns `409 E_FLOOR_TAKEN` with the list of still-available floors. The loser allocates elsewhere in one call. *Closes reference-memo **§5f**, deterministic-ata **§4.4**, and signature-claim's own honest admission — in all three of those, the losing buyer's 50 USDC became an unrefundable manual case. Here it is a redirect.*

**Idempotent replay** is checked **first**, before any credit or floor test. *Closes signature-claim **S11**, where the shown transaction told a buyer retrying after a network timeout that their payment was already spent.*

### 5.3 Confirmation depth policy

| Stage | Requirement |
|---|---|
| Displayed as `pending` | seen in `getSignaturesForAddress` at `finalized` |
| Credit written | `commitment:'finalized'` on **both** agreeing providers **and** `finalizedSlot - tx.slot >= 32` (≈13 s) **and** V0–V12 all pass |
| Floor allocated | credit is `spendable`. No further chain condition — it is a database operation on money already proven. |

### 5.4 Scanner cursor discipline

```
for each treasury-owned USDC token account A:
  pages = []
  before = undefined
  loop:
    r = getSignaturesForAddress(A, { limit: 1000, until: cursor_sig(A), before }, 'finalized')
    pages.push(...r)
    if (r.length < 1000) break                    # reached the cursor or exhausted history
    before = r[r.length - 1].signature            # KEEP PAGING. Never stop at the limit.
  process pages OLDEST → NEWEST
  advance cursor_sig(A) to the newest signature ONLY IF every entry reached a terminal
    state (credited, rejected, or unattributed). Otherwise leave the cursor and retry.
```

*Closes deterministic-ata **S4** and reference-memo **F3**: ~150 spam transactions mentioning the account during one scan window pushed the victim's real payment outside a fixed `limit`, and a cursor advanced to `sigs[0]` skipped it **permanently** — no row, no receipt, no exception, nothing to appeal to. Here a dust flood costs **latency, bounded and quantified**, and never a lost payment. Reprocessing is free because `ux_credits_sig_dest` makes the insert idempotent.*

**Budget and the priority lane.** `getTransaction` is called at most `SCAN_TX_BUDGET_PER_MIN = 600` times. Backlog drains at 600/min; a 10,000-transaction dust flood (≈$5 of fees) delays honest credits by ~17 minutes and nothing else. `POST /nudge` inserts into `scan_queue`, which is drained **first**, round-robin by wallet, capped at 200 entries, 1 per wallet per 60 s, and a wallet whose last 3 nudges resolved to "not a treasury payment" is demoted for an hour. **`/nudge` issues no RPC of its own.** *Closes signature-claim **FATAL 2** — the design's most dangerous flaw, where a free keypair plus a random base58 string forced three archival `searchTransactionHistory` calls and a proxy pool took the sale offline for $2/day. Here RPC volume is a function of treasury inbound transactions, not HTTP traffic, and no rate limit in this system is load-bearing on an identity that costs nothing to create.*

### 5.5 Reorg policy — flag, never revoke; absence is never evidence

Every credit is re-verified at **+10 m, +1 h, +6 h, +24 h, +7 d** against archival providers, then quarterly.

- **Both providers return `null` / error / abstain** → `recheck_count++`, `last_recheck_at` set, **retry with backoff indefinitely**. Alert the operator after 24 h of continuous absence. **No status change. No flag. Ever.** An archival gap, a plan lapse, a failover to a non-archival endpoint, and a real reorg are indistinguishable from the outside, and only one of them is real.
- **≥2 providers return an *affirmative contradiction*** — a non-null result with a different `slot`, a different summed delta, or `meta.err !== null` → `credits.status='contradicted'`, floors funded by it → `status='flagged'`, `ownership_events`, page the owner.
- **A flagged floor keeps running.** The tenant's 14 agents keep working; the floor cannot be re-allocated or reclaimed by an automated path. Only `POST /admin/floors/:n/unflag` or `.../reclaim` changes it, by a human.

**Ownership is never auto-revoked.** Revoking a deed on RPC evidence hands anyone who can make two providers disagree a griefing weapon far more dangerous than the reorg it defends against — and a false positive takes property from a paying customer. *Closes signature-claim **FATAL 3** (three fixed rechecks + "absence counts" = every floor sold today flipped to `disputed` for $2 of proxies) and deterministic-ata **§4.6**'s conflation of pruning with reversal.*

---

## 6. ENDPOINTS

All amounts on the wire are **decimal strings of base units**, with a display field alongside. JSON numbers are never used for money.

**Session auth** (inherited from the wider project's Phantom `signMessage`, with these requirements made explicit because everything else rests on them): the challenge must be **domain-bound** (include the exact origin), carry a **single-use server-issued nonce** with a 5-minute TTL, state its purpose ("Sign in to Claude Tower"), and be verified with ed25519 against the claimed pubkey. Session cookie: `HttpOnly; Secure; SameSite=Lax; Max-Age=86400`. *If the wider project's message is generic and reusable, a signature harvested elsewhere mints a Tower session — and every entitlement check in §4 and §5 reduces to trusting `session.wallet`. This is a hard dependency and is listed again in §7.*

### Public

**`GET /api/tower/config`**
```json
{ "treasuryOwner": "Tw1…", "treasuryAta": "9dXk…2Qz",
  "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "tokenProgram": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "decimals": 6, "priceBaseUnits": "50000000", "priceDisplay": "50.00 USDC",
  "saleState": "open", "saleOpenSlot": 298450112, "maturitySlots": 32,
  "maxFloorsPerWallet": 49, "contact": "tower@…",
  "warnings": [
    "Pay only from a wallet you can sign with. An exchange or custodial withdrawal cannot be attributed to you and cannot be refunded automatically.",
    "There are no automatic refunds of any kind. None. Overpayments and mistakes are returned by hand, at the owner's discretion.",
    "Floors are not reserved. Paying does not hold a specific floor; it gives you credit you spend on any available floor."
  ] }
```
Also served as a static `/tower-manifest.json` and printed on the marketing homepage, so a buyer can compare the treasury address against a source the API cannot rewrite.

**`GET /api/tower/floors`**
```json
{ "saleState": "open", "priceBaseUnits": "50000000",
  "floors": [
    { "floorNo": 1,  "status": "owned",     "ownerWallet": "7xK…9dQ",
      "displayName": "Nightshift Capital", "ownerSince": 1756300000 },
    { "floorNo": 2,  "status": "available" },
    { "floorNo": 13, "status": "flagged",   "ownerWallet": "5Hb…", "note": "under review" },
    { "floorNo": 50, "status": "withheld",  "displayName": "Headquarters" } ] }
```
No `reservedUntil`, because there are no reservations. *Closes reference-memo MINOR and deterministic-ata **S1** — the public targeting oracle.*

**`GET /api/tower/floors/:floorNo`** — the above plus `deskConfig`, `purchaseId`, and the funding signatures. `404 E_NO_SUCH_FLOOR` outside 1–50 (never `E_FLOOR_TAKEN`; *closes signature-claim MINOR*).

### Session-authenticated

**`POST /api/tower/auth/nonce`** → `{ "nonce": "…", "message": "…", "expiresAt": … }`
**`POST /api/tower/auth/verify`** `{ wallet, signature, nonce }` → `200`, sets the cookie.

**`GET /api/tower/me`**
```json
{ "wallet": "7xK…9dQ",
  "credit": { "availableBaseUnits": "50000000", "availableDisplay": "50.00",
              "rows": [ { "creditId": 41, "signature": "5Fj…2aQ", "slot": 298460001,
                          "creditedBaseUnits": "50000000", "consumedBaseUnits": "0",
                          "status": "spendable", "verifiedAt": 1756312399,
                          "explorer": "https://solscan.io/tx/5Fj…2aQ" } ] },
  "floors": [ { "floorNo": 12, "purchaseId": 87, "status": "owned",
                "pricePaidBaseUnits": "50000000", "ownerSince": 1756312410 } ],
  "pending":       [ { "signature": "8Ab…", "state": "awaiting_maturity", "slot": 298460400 } ],
  "unattributed":  [ { "creditId": 44, "signature": "2Zx…", "creditedBaseUnits": "50000000",
                       "reason": "payment_source_not_a_wallet_you_signed_from",
                       "message": "This payment arrived from an account we cannot attribute to your wallet — most often an exchange withdrawal or a multi-source transfer. It cannot be credited automatically and this application cannot return it. Case opened; contact tower@… .",
                       "refundable": false } ] }
```

**`POST /api/tower/nudge`** `{ "signature": "5Fj…2aQ" }` → `202 { "queued": true, "position": 3 }`
Enqueues into the scanner's priority lane. **Performs no RPC.** Rate limit: 1 per wallet per 60 s, queue capped at 200. `409 E_ALREADY_KNOWN` if the signature is already credited or rejected. Purely a latency optimisation — omitting it changes nothing about the outcome.

**`POST /api/tower/allocate`** — header `Idempotency-Key: <uuid>`
```json
{ "floorNo": 12 }
```
`201`:
```json
{ "ok": true, "purchaseId": 87, "floorNo": 12, "ownerWallet": "7xK…9dQ",
  "pricePaidBaseUnits": "50000000",
  "debits": [ { "creditId": 41, "amountBaseUnits": "50000000", "signature": "5Fj…2aQ" } ],
  "remainingCreditBaseUnits": "0", "deskSeeded": true, "replay": false }
```
`200` — identical body with `"replay": true` on a retry of the same `(Idempotency-Key, wallet)`.
Errors: `401 E_UNAUTHENTICATED` · `404 E_NO_SUCH_FLOOR` · `409 E_FLOOR_NOT_FOR_SALE` (floor 50) · `409 E_FLOOR_TAKEN` *(credit untouched; body lists `availableFloors`)* · `409 E_INSUFFICIENT_CREDIT` · `409 E_WALLET_FLOOR_LIMIT` · `409 E_SALE_NOT_OPEN` · `429 E_RATE_LIMITED`.
Every response involving money carries `"refundable": false`, rendered by the client as a sentence, not a badge. Error bodies never enumerate which internal check failed. *Closes reference-memo MINOR — `422 verification_failed {checks:[…]}` told an attacker exactly which check they tripped.*

**`PATCH /api/tower/floors/:floorNo`** `{ displayName, deskConfig }` — must be `owner_wallet`; permitted while `flagged`. `403` otherwise.

### Admin — `X-Tower-Admin: <ADMIN_KEY>`, Render env only, never in a repo, a client, a response body, or chat

**No admin endpoint returns a transaction, signed or unsigned, and none moves money.** *Closes deterministic-ata **F1** — the base64 blob the owner blind-signs on a Ledger, which a compromised server turns into `SetAuthority` and owns all future revenue. There is no such blob in this system.*

- `GET /api/admin/tower/reconcile` — walks **every** treasury-owned USDC token account (from `getTokenAccountsByOwner`, not just the canonical ATA — *closes signature-claim MINOR, where the audit job and the credit path disagreed on scope*) and diffs on-chain inbound history against `credits`. Reports: uncredited inbound, `unattributed` totals, credits with no matching chain record, and a signed ledger identity `Σcredited − Σconsumed − Σvoided = outstanding credit`. Manual refunds appear as `voided`, so the identity **closes** rather than drifting from week one. *Closes reference-memo MINOR.*
- `GET /api/admin/tower/unattributed` — the human queue.
- `POST /api/admin/tower/credits/:id/attribute` `{ "wallet": "…", "note": "…" }` — sets `payer_wallet`, `status='spendable'`, records `reattributed_from`. For the exchange-withdrawal buyer who proves identity out of band.
- `POST /api/admin/tower/credits/:id/void` `{ "note": "…", "refundSignature": "8kL…" }` — for unspent credit returned by hand. Increments `voided_base_units`. **Records a refund; it cannot perform one.**
- `POST /api/admin/tower/floors/:floorNo/reclaim` `{ "refundSignature": "8kL…", "reason": "…" }` — sets `purchases.status='reclaimed'`, clears `floors` back to `available`, voids the corresponding debits' credit amounts. **Requires a `refundSignature` (DB `CHECK`).** *Closes signature-claim **FATAL 4** — the owner hand-refunds 50 USDC and the attacker keeps the floor, repeatable with a fresh wallet per iteration.*
- `POST /api/admin/tower/floors/:floorNo/unflag` `{ "note": "…" }` — clears a `contradicted` false positive, restoring `owned`.
- `POST /api/admin/tower/floors/:floorNo/grant` `{ "wallet": "…", "note": "…" }` — off-platform sales. Subject to the same `CHECK (floor_no <> 50 …)` as every other path.
- `POST /api/admin/tower/sale-state` `{ "state": "open" | "paused" | "closed" }` — **read by `/allocate` on every call.** *Closes signature-claim **S6**, where the kill switch was declared and never consulted.* Note that `paused` cannot stop money arriving; credits keep accruing and become spendable when the sale reopens.
- `GET /api/admin/tower/health` — provider slots, lag, budget consumption, backlog, queue depth.

---

## 7. WHAT REMAINS UNSAFE

Stated on the payment screen **before** the buyer signs, not in a footer.

1. **There are no refunds. None, ever, automatically.** Issuing one requires signing a transfer out of the treasury, which requires the treasury's private key, which the server must never hold. Overpayments beyond what credit can absorb, payments from unattributable sources, and "I changed my mind" all end at a human sending USDC by hand from their own wallet, at their discretion, recorded — not performed — by the admin endpoints. **The credit ledger removes most of the *need* for a refund; it does not create the ability to give one.**
2. **A payment from an exchange or any custodial account cannot be attributed.** The debited token account is the exchange's, so the credit lands `unattributed` and needs a human. This is the single most likely way a real person loses 50 USDC here, and it is unavoidable without custody. The warning ships in `/config`, in the pay dialog, and in 16px type next to the button.
3. **A transaction that debits two different owners is `unattributed`.** Guessing which one to credit would be inventing an entitlement. A human decides.
4. **You cannot hold a specific floor.** There is no reservation, by design (§1). If you want floor 13 and lose the race by four seconds, you hold 50 USDC of credit and 48 other floors. That is a redirect, not a refund, and calling it a refund would be a lie.
5. **Paying and allocating cannot be made atomic.** There is a 15–45 s window (occasionally minutes under a dust flood, §5.4) where the money is irreversibly on chain and the database does not yet say so. The chain is the source of truth for money; the database is the source of truth for ownership; they are only *eventually* consistent. Any UI implying otherwise is lying.
6. **A payment to the wrong address is invisible and unrecoverable.** Wrong chain, wrong token, a fat-fingered address — nothing in this system ever sees it. No detection, no recovery. Client-side re-derivation of the treasury ATA from constants baked into the bundle, plus manual comparison against the homepage and `/tower-manifest.json`, **reduces but does not eliminate** the frontend-compromise case: an XSS, a poisoned dependency, or a hijacked static host that rewrites both the bundle and the API takes every payment, and the server's own monitors see only "nobody bought anything today." *This is deterministic-ata **S7** and signature-claim **S10**, and it is genuinely unclosable from the server.*
7. **RPC quorum is mitigation, not proof.** Two independent archival providers agreeing on the fact tuple raises the bar from "compromise one endpoint" to "compromise two operators at different companies simultaneously". It is not consensus verification. A real proof needs a light client validating block headers against the validator set. If both agreeing providers are wrong or share an upstream, this system credits money that never arrived.
8. **Ownership is a row in a SQLite file.** Not an NFT, not composable, not transferable on chain, not verifiable by anyone but this server, and worthless if the server goes away. 50 USDC buys a database row and the compute behind fourteen agents. The purchase screen should say exactly that.
9. **Database loss loses allocations, not credits.** Credits are fully reconstructible by replaying the treasury accounts' history. **Floor allocations and every human remediation decision are not.** The `ownership_events` JSONL mirror and the off-box backup are therefore load-bearing infrastructure, not hygiene. Worse if ignored: after a bare rebuild, every credit in history becomes spendable again on floors that have reverted to `available`, while the original owners still believe they own them — *signature-claim **S12***. Render's **default filesystem is ephemeral**; without an explicitly attached persistent disk this happens on **every deploy**. This project has already lost 2,443 rosters to exactly this class.
10. **A dust flood delays settlement.** ~10,000 transactions mentioning a treasury account (≈$5 of fees) pushes credit latency to ~17 minutes. The priority lane keeps honest buyers ahead of it, but a determined flooder with 200 free wallets can contest the lane too. Bounded, quantified, and it never loses a payment.
11. **Trust in the operator is total.** No on-chain mechanism constrains the owner. Buyers trust that the treasury address is the owner's, that floors will be honoured, and that manual settlements will be fair.
12. **Session auth is inherited and load-bearing.** Every entitlement check reduces to `session.wallet`. If the wider project's signing challenge is not domain-bound, nonce-bound and expiring, a signature harvested for any other purpose mints a Tower session. §6 lists the requirements; **verify them against the existing implementation before launch, not after.**
13. **No sanctions screening, no KYC, no tax handling, no jurisdiction logic**, and no legal position on what a "floor" is.

---

## 8. IMPLEMENTATION NOTES

### 8.1 Environment (all values public except `ADMIN_KEY` and the RPC keys)

```
CTWR_TREASURY_OWNER      = <owner's Solana wallet address, base58, system-owned>
CTWR_USDC_MINT           = EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
CTWR_TOKEN_PROGRAM       = TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
CTWR_PRICE_BASE_UNITS    = 50000000
CTWR_MATURITY_SLOTS      = 32
CTWR_MIN_CREDIT_BASE_UNITS = 1000
CTWR_RPC_A / _B / _C     = <three archival providers, three different companies>
CTWR_DB_PATH             = /var/data/tower.db          # a Render PERSISTENT DISK
CTWR_ADMIN_KEY           = <server env only; never a repo, a client, a body, or chat>
```

`CTWR_TREASURY_ATA` is **derived at boot, never configured** — a typo in an env var must not be able to point payments at an address the owner does not control:

```js
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';

const TREASURY_ATA = getAssociatedTokenAddressSync(
  new PublicKey(USDC_MINT), new PublicKey(TREASURY_OWNER),
  false,                                    // allowOwnerOffCurve
  new PublicKey(TOKEN_PROGRAM_ID)           // classic SPL Token, NOT Token-2022
);
```

### 8.2 The no-custody lint gate (CI, blocking)

```
grep -rnE '\b(Keypair|VersionedTransaction|new Transaction|sendTransaction|sendRawTransaction|simulateTransaction|signTransaction|signAllTransactions|fromSecretKey|bip39|derivePath)\b' server/ && exit 1
```
Plus a boot assertion that `process.env` contains no key ending in `_SECRET`, `_PRIVATE_KEY`, or `_MNEMONIC`. The server's `Connection` objects are constructed once, in one module, and that module exports only read wrappers.

### 8.3 Exact RPC methods and parameters — the complete list

| Method | Exact params | Where |
|---|---|---|
| `getSlot` | `{ commitment: 'finalized' }` | health poll (30 s), V4 |
| `getAccountInfo` | `(TREASURY_ATA, { commitment:'finalized', encoding:'jsonParsed' })` | boot + hourly audit |
| `getTokenAccountsByOwner` | `(TREASURY_OWNER, { mint: USDC_MINT }, { commitment:'finalized', encoding:'jsonParsed' })` | boot + hourly; defines the scanned account set |
| `getSignaturesForAddress` | `(account, { limit: 1000, until: cursor_sig, before }, 'finalized')` | scanner discovery, §5.4 |
| `getTransaction` | `(sig, { commitment:'finalized', maxSupportedTransactionVersion: 0, encoding:'jsonParsed' })` | V1–V12, the authoritative read |
| `getSignatureStatuses` | `([sig], { searchTransactionHistory: true })` | **recheck job only**, never reachable from an HTTP handler |
| `getTokenAccountBalance` | `(account, 'finalized')` | `/admin/reconcile` dashboard only; **barred from the verification path** |

**Not present, at any commitment, anywhere:** `sendTransaction`, `sendRawTransaction`, `simulateTransaction`, `requestAirdrop`, `getLatestBlockhash` (the *client* fetches that for its own transaction).

### 8.4 `node:sqlite` specifics

- `import { DatabaseSync } from 'node:sqlite'` — synchronous API, which is exactly what `withTx` needs.
- **Money is `BigInt` end to end.** Call `stmt.setReadBigInts(true)` on every statement that reads an amount column, bind `BigInt` values directly, and never let a base-unit value pass through a JS `Number`. `uiAmount` / `uiAmountString` from the RPC are floats and are read nowhere.
- Two connections: one **write** connection used exclusively inside `withTx`, one **read** connection for `GET` handlers. Never share.
- `STRICT` tables require SQLite ≥ 3.37; Node 22's bundled SQLite is well past that. Assert `PRAGMA compile_options` at boot if paranoid.
- `raw_json_a` and `raw_json_b` store the responses from **both** agreeing providers. Storing only one means the audit you would need if provider A lied is the response you discarded. *Closes reference-memo **S6**.* Prune `raw_json_*` older than 400 days by an explicit job, with the `facts_json` tuple retained forever.

### 8.5 Boot sequence (server refuses `sale_state='open'` until all pass)

1. Open the DB, run migrations, assert `schema_version`.
2. Derive `TREASURY_ATA`. `getAccountInfo` → assert non-null, `owner === TOKEN_PROGRAM_ID`, parsed `mint === USDC_MINT`, parsed `owner === TREASURY_OWNER`, `state === 'initialized'`. Failure → `sale_state='paused'`, reads keep serving, page the owner. Never a 503 on the read paths.
3. `getTokenAccountsByOwner` → seed `scan_state` for every treasury-owned USDC account.
4. **Provider compatibility probe.** For each of the three providers, `getTransaction(KNOWN_GOOD_HISTORICAL_SIG)` and assert that `meta.postTokenBalances[0]` carries `owner`, `mint`, `programId`, and `uiTokenAmount.amount` as a string. A provider missing any field is **excluded from quorum** and logged loudly. *Closes deterministic-ata **M4** — `undefined === 'Tokenkeg…'` silently rejecting every payment.*
5. Assert `sale_open_slot` is set and `<= getSlot('finalized')`.
6. Idempotent desk-provisioning sweep: any `purchases` row whose floor has `desk_seeded_at IS NULL` is provisioned now. Repairs a crash between commit and provisioning.

### 8.6 Render deployment

```yaml
services:
  - type: web
    name: claude-tower
    env: node
    numInstances: 1                 # EXPLICIT. Every race guard rests on one writer.
    disk:
      name: tower-data
      mountPath: /var/data          # persistent. Not the default filesystem.
      sizeGB: 1
    healthCheckPath: /api/tower/health
```

- **Deploys must restart, not overlap.** Two instances against one file breaks every guarantee in §5: WAL does not serialise across processes, `busy_timeout` protects nothing across containers, and two scanners double-write.
- **Backups:** `PRAGMA wal_checkpoint(TRUNCATE)` then `VACUUM INTO '/var/data/backup-<ts>.db'` hourly, copied off-box (R2/S3) with a 30-day retention. `ownership_events` is additionally appended to `/var/data/events.jsonl` on every write and shipped with the same job.
- **After deploying, curl the live endpoints** and check status *and* byte count — a file on disk is not a file on the web. `/tower-manifest.json` must return the same treasury address the bundle derives.

### 8.7 Background jobs (in-process, single instance — stated because it is a correctness requirement)

| Job | Cadence | Notes |
|---|---|---|
| `scanTreasury` | every 10 s while credits are pending, else 60 s | §5.4; drains `scan_queue` first |
| `recheckCredits` | every 60 s, selecting due rows | §5.5; absence never changes state |
| `auditTreasuryAccounts` | hourly | re-run `getTokenAccountsByOwner` + `getAccountInfo`; a changed ATA authority is a compromise signal → `sale_state='paused'`, page |
| `providerHealth` | every 30 s | `getSlot` on all three; a provider >600 slots behind the max abstains from quorum |
| `provisionDesks` | every 60 s | idempotent, keyed on `purchases.id` |
| `backup` | hourly | checkpoint, `VACUUM INTO`, ship off-box |

### 8.8 Client-side obligations (non-negotiable, they close §7.6 as far as it can be closed)

```js
// Constants BAKED INTO THE BUNDLE. Not fetched.
const TREASURY_OWNER = 'Tw1…';
const USDC_MINT      = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN_PROGRAM  = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

const derived = getAssociatedTokenAddressSync(
  new PublicKey(USDC_MINT), new PublicKey(TREASURY_OWNER), false, new PublicKey(TOKEN_PROGRAM));

const cfg = await fetch('/api/tower/config').then(r => r.json());
if (cfg.treasuryAta !== derived.toBase58() || cfg.treasuryOwner !== TREASURY_OWNER) {
  throw new Error('Treasury address mismatch — refusing to build a payment.');
}

const ix = createTransferCheckedInstruction(
  buyerUsdcAta, new PublicKey(USDC_MINT), derived,   // <- the DERIVED address, not the response
  buyerPubkey, 50_000_000n, 6);                      // transferChecked rejects a mint/decimals mismatch

const tx = new Transaction().add(ix);
tx.feePayer = buyerPubkey;
tx.recentBlockhash = (await conn.getLatestBlockhash('finalized')).blockhash;
const { signature } = await window.solana.signAndSendTransaction(tx);  // BUYER signs, BUYER submits
```

The UI must display `derived` in full for manual comparison against the homepage, and must render — before the pay button, not after — the three sentences from `config.warnings`.

---

**Bottom line.** The theft surface in all three source designs was already closed by one shared primitive: **the summed pre/post token-balance delta on a destination pinned by owner, mint and token program.** That is kept verbatim. Every fatal finding across all three reviews was about *availability, griefing, and buyers losing money* — and every one of those descended from a single structural error the three designs made in three different costumes: **a floor-scoped exclusive lock that costs nothing to acquire, plus an entitlement derived from something other than whose tokens actually moved.** This spec deletes the lock and fixes the entitlement to the debited account's owner. What is left is a 15–45 second eventual-consistency window, an honest list of things only a human with the treasury key can do, and a SQLite file that must be on a persistent disk.