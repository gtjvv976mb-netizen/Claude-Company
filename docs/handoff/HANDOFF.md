# Handoff — the Claude Co / BAGWORK session, written down

Written 2026-09-26 by the Claude Code session `session_01F71n8BkTmDSf7vg3XzRX3p`. It was first
written so a different Claude account could take over; the owner then chose to **keep working in
the original session**, which finished the PR #45 review and fixed what it found (§6). The file
stays as the record of everything that otherwise lived only in the conversation — decisions,
measurements, traps, what is pending. Any session picking this up: read it all before touching
anything.

---

## 0. Where things stand, in one screen

| | |
|---|---|
| **Repo** | `gtjvv976mb-netizen/Claude-Company` (the desk + the executor). *Not* `Claude-Company-Solana` — that repo only republishes the site from this repo's `main` on a schedule and holds none of this work. |
| **Branch** | `claude/eloquent-mayer-3jwcyb` — all development goes here |
| **Open PR** | [#45](https://github.com/gtjvv976mb-netizen/Claude-Company/pull/45) "Everything BAGWORK runs on — and the parts of it that are wrong" — **open, not merged** |
| **Last code commit** | the review-fix commit on top of `a8d885e` — see `git log` on the branch |
| **Base (`main`)** | `5646b1c` — an ancestor of the branch |
| **Tests** | the full suite passes on the review-fix commit (count in the PR description) |
| **Review** | done — ~25 confirmed findings, all fixed on the branch (§6) |

**The immediate next steps are §7.** Nothing in §7 needs the old conversation.

---

## 1. Standing rules — the owner set these; keep them

- Develop on `claude/eloquent-mayer-3jwcyb`. PRs are squash-merged to `main` **by the owner**.
  Merging deploys the desk to Render. Do not merge without being told to.
- **Never print or handle secrets** (`CC_SECRET`, private keys, RPC/gRPC tokens). The owner's env
  values are double-quoted; strip with `tr -d '"'` when reading one.
- **Never disable TLS verification or unset `HTTPS_PROXY`.** Chromium cannot reach public HTTPS
  through the cloud sandbox's proxy: serve downloaded pages over local HTTP instead, never
  `ignoreHTTPSErrors`.
- **Money actions need the owner's explicit say-so**: launching a coin, funding a wallet, signing
  anything. Nothing in this system signs a creator-fee claim; the owner does (§3.1).
- Never put model identifiers in commits, PR bodies or code beyond the attribution lines.
- The owner writes short, often all-caps instructions ("DO IT", "continue"). Read them as "proceed
  with the obvious next thing"; they have consistently wanted work done rather than discussed.
  Keep replies plain and outcome-first.

---

## 2. What the owner asked for, in order

1. Get HAWK-AI (the launch sniper) onto a faster feed → Helius LaserStream gRPC, region **`sgp`**
   (measured 94 ms, best of all regions from the owner's Mac). Merged in PR #40.
2. "Why is the bot unprofitable" → measured (§4). Built the shadow-book persistence and the grader
   (PR #42, #43).
3. `https://bagworkagent.fun/#/agent/59` — "study this site, implement it in Claude Co, make it
   better". Owner picked **all four** slices: creator-fee revenue, stop sniping / trade established
   tokens, public agent pages + live stream, levels / rewards / strategy builder.
4. "When volume spikes on a token, that's a sign to get in and ride the wave" → volume-spike gate.
5. "Do everything that makes BAGWORK work, and improve it" → PR #45 as it stands.
6. "What kind of coin will each user launch?" → answered: the house coin `$CLAUDECO` already exists
   and the owner **holds its creator key**. Owner chose **house coin first**; per-floor coins are a
   later opt-in.
7. "Move this to my other account" → this file. Then: "continue here everything, no need for
   other account" → the transfer was cancelled and the original session carried on (§6).

---

## 3. What PR #45 contains (six code commits)

### 3.1 Creator-fee claim — the owner signs, nothing else can
- `executor/pumpfun-fees.mjs` — the claim instruction, decoded from **three transactions that
  landed on mainnet**. Two programs, two vaults:
  - bonding curve `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`, disc `1416567bc61cdb84`, seed
    `["creator-vault", creator]` (**hyphen**)
  - pump-amm `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`, disc `a039592ab58b2b42`, seed
    `["creator_vault", creator]` (**underscore**)
  - Both spellings derive a valid address; the wrong one owns nothing. Pinned in tests.
- `src/fee-claim.js` + `GET /api/fees/claimable` + `GET /api/fees/claim-ticket` — the desk builds
  the **unsigned** instructions (no blockhash, no fee payer). Deliberately ungated: public facts,
  only the creator can sign.
- `viewer/fees.html` — owner connects the creator wallet and signs. Refuses a non-creator wallet.
- **Design decision (final):** the creator key never goes on the Mac. `FEE_CLAIM=live` is refused
  permanently with that reason. The bot reads; the desk builds; the owner signs.

### 3.2 Fee lane — `executor/fee-lane.mjs`
- Reads both vaults on a timer, decides net of the transaction's own cost (0.002 SOL floor), books
  to **its own file** `<state-db>.fees.jsonl`. Never summed with trading P&L — `feeSummary()` has
  no `total`/`pnl`/`net` field, asserted by name.
- `FEE_CLAIM=dry` + `FEE_CLAIM_CREATOR=<wallet>`; stats ride the heartbeat as a `fees` block.
- Rent reserve **650,240 lamports**, *measured* (`getMinimumBalanceForRentExemption(0)`). It was
  first written as 890,880 from memory — always ask the chain.

### 3.3 Market floor — `executor/snipe-market.mjs`, gate `market_floor`
- `SNIPE_MARKET_FLOOR=bagwork` = BAGWORK's floor, literally: `minAgeHours 1`, `minLiquidityUsd 30000`,
  `minVolume24hUsd 50000`, `minMcapUsd 50000`. **On this desk it admits nothing** — a standard curve
  graduates at 85.005 SOL (~$10.3k at SOL $121.69), so the liquidity and cap bars are out of reach
  on a curve. **`SNIPE_MARKET_FLOOR=curve`** (age ≥ 1 h, 24 h volume ≥ $50k — the two a curve can
  meet) is the preset to run; the lane prints a startup warning for any unreachable threshold.
  Plus five of ours, all off by default: volume/depth, 24h trade count, sell share, 24h run-up,
  deepest-pool depth (the curve itself now counts as a pool).
- Liquidity = the curve's real SOL reserve × SOL/USD; SOL/USD derived free from DexScreener as the
  median `priceUsd/priceNative` over **WSOL-quoted pools only** (non-SOL-quoted curves exist).
- **Momentum source**: pump.fun `sort=last_trade_timestamp` listing (verified live), pre-filtered,
  added beside the launch sources.
- **Honest limit**: only pump.fun bonding-curve buy/sell layouts are proved here, so the floor
  applies to coins still on their curve. Bonded (AMM) coins would need a pump-amm buy layout proved
  against landed transactions.
- Startup **warning** (not a refusal): an age floor below the feed's 30-min dedupe TTL loses the
  band of candidates between the two that a launch source already heard; older ones still arrive.

### 3.4 Volume spike — `executor/snipe-volume.mjs`, gate `volume_spike`
- Net SOL inflow over 30 s vs the 5 min before, fed from gRPC trade events the feed used to drop.
  Rates are per **window**, not per gap between samples (the review's finding I).
- No-baseline → `null`, never Infinity. Samples are 2-second buckets (one sample per trade let a
  hot coin evict its own baseline). **Ships measure-only** (`SNIPE_MIN_VOLUME_SPIKE` unset).
- A launch notice can never be measured (no 5-minute history 30 s after birth), so setting the dial
  mounts the momentum source and **requires `SNIPE_GRPC_*`**; the grader leaves an unmeasured ruler
  out of its verdict by name.

### 3.5 Agent pages, levels, rewards, strategy builder (desk)
- `src/agent-desk.js` (pure rules), `src/agent-store.js` (tables `agent_strategies`,
  `agent_rewards`), `GET /api/agent/:floor`, `POST /api/agent/:floor/strategy`, `viewer/agent.html`.
- Levels need a **record**, not just activity. Rewards idempotent (filter + unique index).
  Strategy builder refuses any dial the lane does not read.
- SSE: named events `fees`, `levelup`, `reward` added **additively** (existing clients use
  `onmessage`, which only sees unnamed events).

### 3.6 Plumbing fixes found on the way
- 19 `SNIPE_*` dials were never allowed through launchd or carried by the installer — fixed; a test
  now derives the requirement from `SNIPE_ENV`.
- `pumpfun-fees.mjs` was published by no list — fixed (the bot would have died at boot).
- Four install texts behind the 2026-09-18 outage fixed (§5).

---

## 4. Facts measured this session — reuse, don't re-derive

**The owner's sniper record (64 real trades):** −0.361 SOL, 5 winners. Entries < 3 s: 0% win,
−18.5%. Entries ≥ 10 s: 40% win, +34.0%. No entry signal ordered the outcome (Spearman: buyers ahead
+0.109, seconds late +0.083, curve trades −0.126). pump.fun fees 95 bps protocol + 30 bps creator =
1.25%/side; fees ≈ 45% of the average loss.

**BAGWORK (26 agents, 362 closed trades):** trading −0.077 SOL, creator fees +14.515, rewards
+0.620. #1 agent took 6.196 SOL of fees (43%); the other 25 averaged ~0.33 SOL (~$40). At 30 bps
that is ~110 SOL (~$13k) of volume for a typical coin, ~2,065 SOL (~$251k) for the top one.

**SOL/USD on 2026-09-26: $121.69** (an earlier draft of these notes assumed $200 — the dollar
figures above are at $121.69).

**On-curve market, 2026-09-26, the 70 most recently traded coins:** 25 on a curve, 45 bonded. The
deepest on-curve SOL-quoted curve held 68 SOL; the top on-curve cap was $36k; 5 on-curve coins were
≥ 1 h old and none had a $50k cap. 24 h volume on on-curve coins: $110,756 (2.4 h old), $97,857
(10.2 h), $69,878 (0.2 h), $31,201, $28,312, the rest under $9k. DexScreener lists pumpfun pairs
with `liquidity` absent. Listing rows carry `metadata_uri`, not `uri` (50 of 50).

**`$CLAUDECO`:** mint `HRkkxgaFDDmZ3qZX8xP5SiMRBNvFNVUUv4FJUjPCpump`, **bonded**, creator
`3J57tqAJqRmSBn1ZYDu9JpMMyTfBHdcGGwECiPQeiji3` (**the owner holds this key**). Vaults on 2026-09-26:
curve `5TmPpLwreotwnpVqWdgwDEwSMv5RzUUcskH3NYCazUPq` 3,571,512 lamports; pump-amm ATA
`98yKMqgKXU2xKSoytgqT9njgwHdUTqcbYpWhKG6Mv8HN` 4,147,526 → ~0.00707 SOL claimable after rent.

**LaserStream:** region `sgp`, `processed` commitment.

---

## 5. Traps — each of these has already cost time

- **Never `load` through `current`.** `bash ~/claudeco-executor/current/macos-launchagent.sh load`
  can never work on a live install (`pwd -P` resolves the symlink, the rendered plist cannot match
  the installed one byte for byte). It took the bot down on 2026-09-18. Load from
  `~/claudeco-executor/versioned-releases/<full-sha>/executor/macos-launchagent.sh`.
- **Re-running the installer at the same commit always fails** ("release already exists") and
  rolls back. That is expected. When install.sh gets there the LaunchAgent is **unloaded** (the
  installer refuses to run while it is loaded), so the bot is stopped — the message now says so
  and names the controller at `<release>/executor/macos-launchagent.sh`.
- **A new runtime module must be registered in seven places**: `install.sh` (source_file loop
  **and** `RUNTIME_FILES`), `macos-release.sh` `RUNTIME_PATHS`, `scripts/build-viewer.mjs`
  `EXECUTOR_FILES`, `executor/heartbeat-health.mjs` fingerprint, `executor/launchd-runner.mjs`
  file list (+ `ALLOWED_ENV` for env vars), `executor/test-install.mjs`, `executor/test-launchd.mjs`
  fixture. New env dials: `ALLOWED_ENV` **and** the `install.sh` upgrade carry loop.
- **Lane modules must be dynamic imports** inside `poller.mjs`'s `SNIPE_LANE !== "off"` branch
  (`test-snipe-wiring.mjs` forbids static imports).
- **`@solana/web3.js` resolves only from `executor/node_modules`.** Ad-hoc scripts that need it
  must live inside `executor/`. `src/` may import executor modules (the Render build installs both).
- **`Number(null) === 0`** has produced a confident wrong zero three times in this subsystem.
  Absent check first, always.
- **Stale tracking refs**: `origin/claude/eloquent-mayer-3jwcyb` in a local clone can lag the real
  remote and fake a conflict. Use `git ls-remote origin` before believing a conflict.
- This repo runs **no PR CI**. The real gate is Render's `npm ci && npm ci --prefix executor
  --ignore-scripts && npm test` on `main` after merge.

**Running the suite** (≈7–10 min):
```bash
cd <repo>
mv node_modules/playwright /tmp/pw-hidden 2>/dev/null   # playwright is not a project dep; the suite trips on it
node scripts/test-all.mjs
mv /tmp/pw-hidden node_modules/playwright 2>/dev/null
```

---

## 6. The review — done, and fixed

An exhaustive review of PR #45 ran as a Claude Code Workflow (script committed at
`docs/handoff/review-pr45.workflow.js`): six areas, two finders each. The machine's 4 CPUs capped
the workflow at 2 concurrent agents, so after the 12 finders the ~120 queued verifiers would have
taken most of a day; the session stopped it there and verified each finding directly instead —
reproducing the important ones against live data, a headless browser, or the real server.

Confirmed and fixed on the branch (letters are the session's own labels):

| | finding | fix |
|---|---|---|
| A | every momentum candidate refused at `no_socials` — listing rows carry `metadata_uri`, the lane read `uri` | read both |
| B | `bagwork` admits nothing on a curve (see §4) | `curve` preset + startup warning; README recommends `curve` |
| C | `fees.html` called Node's `Buffer` — "Buffer is not defined" in every browser, before any wallet was asked | `atob` → `Uint8Array`; verified in headless Chromium with stub wallets |
| L, M | wallet-standard discovery read `navigator.wallets` wrongly; the Sign button's rule was split between two paths that disagreed | discovery by registration (as `tower.html`); one `refreshClaimButton()` |
| D | `volume_spike` is never measured on launches, so the grader's "no edge" verdict was unreachable | sufficiency over measured rulers; the unmeasured one is named |
| E | the "release already exists" restart command pointed at a file that does not exist | `<release>/executor/macos-launchagent.sh`, and it says the bot is stopped |
| F | `FEE_CLAIM_INTERVAL_MS=30m` → NaN → ~1 ms RPC flood; bad floor / creator not caught | validated at startup, refused by name |
| G | a momentum source keeping 0 of 70 rows was reported DEAD | a successful poll counts as liveness; its drop tally rides the heartbeat |
| H | with a floor armed every launch notice paid a DexScreener request age alone already refuses | skipped and counted (`marketReadsSkipped`) |
| I | spike rate divided by the gap between samples, not the window (2.7x "spike" on slowing flow; 90x read as 7.9x) | per-window rates; uneven-tape tests |
| J | every restart announced "claimed 0.000000 SOL"; the agent page showed the dry lane's zero as revenue | only a rising claim count is news, restart-aware; page shows claimed (dash) and **waiting** separately |
| K | `/api/fees/claimable` public, uncached, 2–6 RPC calls per request | 20 s per-creator cache, shared in-flight read, bounded, `fresh=1` floored at 3 s |
| N | a failed curve read beside an absent AMM account became a measured zero | half a reading is `unreadable`/`partial`, never a total |
| O | the trade tap's and tape's counters never left the process | `snipe.flow` on the heartbeat |
| P, Q | the pre-filter's "gate can measure cap from DexScreener" was false; top-pool depth unmeasurable on-curve | DexScreener cap is the fallback (smaller wins on a 3x disagreement); the curve counts as a pool |
| R, 33 | dedupe guard refused the lane over a partial loss, and missed the no-age-floor case | a warning naming the band, age 0 when unset |
| 38 | a spike threshold with no trade tap refused every candidate | refused at startup; the dial mounts the momentum source |
| T | a guest pass-holder got the tenant's open positions, closed book and raw bot errors | raw blocks only for HQ or the tenant |
| U, V | an unreadable record read as 0 SOL and booked a reward; win rate divided by the wrong count; a 200-row window was treated as the record | lifetime totals from one SQL aggregate; `readable = wins + losses`; a partial tally advances nothing |
| W | `agent.html` never sent the session, so a tenant's own page said "private" | bearer on the fetch, `sid` on the stream |
| X | a week-old pulse read "running" | 150 s freshness, "last heard … ago" |

New tests: `test-agent-route.mjs` (the route against the real server), plus additions in the
volume, market, lane, feed, fee-lane, fee-claim, hawk-board, shadow-sink, launchd and agent-page
suites.

---

## 7. What to do next

**Engineering:**
1. Watch PR #45 until the owner merges it. After merge, the Render deploy is the gate — check it.

**The owner's own steps (these need the owner, not Claude):**
1. **Merge PR #45.**
2. **Upgrade the Mac** at the merged commit: `git pull`, unload using the path the installer
   prints, run `install.sh` again (it detects the prior install and carries settings forward),
   load from the **versioned** path. Every new dial ships off, so the upgrade alone changes nothing.
3. **Turn on what they want**, in the env file:
   ```bash
   FEE_CLAIM=dry
   FEE_CLAIM_CREATOR=3J57tqAJqRmSBn1ZYDu9JpMMyTfBHdcGGwECiPQeiji3
   SNIPE_MARKET_FLOOR=curve            # stops buying the population that lost money; NOT bagwork
   ```
   `SNIPE_MIN_VOLUME_SPIKE` should wait for a scorecard, and needs `SNIPE_GRPC_*` set:
   `node ~/claudeco-executor/versioned-releases/<sha>/executor/grade-entry-gates.mjs`.
4. **Claim fees** at `solana.claudedotcompany.com/fees.html` whenever the page says the net is worth it.

**Last known state of the owner's Mac** (unverified since): running release `e6dd559…` with the
shadow book persisting and LaserStream `sgp` armed. PR #43 (`5646b1c`) and PR #45 are not on it.

**Not done, and why:**
- No trading edge was found. Nothing claims one — the volume spike ships unarmed because nobody has
  graded it.
- Owner-signed claims made at `/fees.html` are not recorded by the desk, so "claimed" on the agent
  page is a dash; recording them (the page posts the signature, the desk verifies it on chain) is a
  possible follow-up.
- Per-floor coin launches (a prepare / image / fund / confirm flow) — deferred by the owner's choice.
- A pump-amm buy layout (needed to trade bonded coins) — not proved; needs landed transactions.
