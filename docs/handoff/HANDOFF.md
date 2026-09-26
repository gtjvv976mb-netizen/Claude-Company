# Handoff — continue the Claude Co / BAGWORK session

Written 2026-09-26 by the Claude Code session `session_01F71n8BkTmDSf7vg3XzRX3p`, so that a
**different Claude account** can pick up exactly where it stopped. A conversation cannot be moved
between accounts, so everything that lived only in that conversation — the decisions, the
measurements, the traps, what is pending — is written down here. If you are the new session: read
this whole file before touching anything.

---

## 0. Where things stand, in one screen

| | |
|---|---|
| **Repo** | `gtjvv976mb-netizen/Claude-Company` (the desk + the executor). *Not* `Claude-Company-Solana` — that repo only republishes the site from this repo's `main` on a schedule and holds none of this work. |
| **Branch** | `claude/eloquent-mayer-3jwcyb` — all development goes here |
| **Open PR** | [#45](https://github.com/gtjvv976mb-netizen/Claude-Company/pull/45) "Everything BAGWORK runs on — and the parts of it that are wrong" — six code commits, **open, mergeable, not merged** |
| **Last code commit** | `a8d885e` "The fee claim, signed by the owner and by nothing else" |
| **Base (`main`)** | `5646b1c` — an ancestor of the branch; a test merge is clean |
| **Tests** | `192/192` test files pass on `a8d885e` |
| **In flight when written** | An adversarially-verified review of PR #45 (§6). Its results will be committed to `docs/handoff/review-results.md` if they land before the old session goes idle; if that file does not exist, re-run it. |

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
7. "Move this to my other account" → this file.

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
- `SNIPE_MARKET_FLOOR=bagwork` = BAGWORK's measured floor: `minAgeHours 1`, `minLiquidityUsd 30000`,
  `minVolume24hUsd 50000`, `minMcapUsd 50000`. Plus five of ours, all off by default:
  volume/depth, 24h trade count, sell share, 24h run-up, deepest-pool depth.
- Liquidity = the curve's real SOL reserve × SOL/USD; SOL/USD derived free from DexScreener as the
  median `priceUsd/priceNative` over **WSOL-quoted pools only** (non-SOL-quoted curves exist).
- **Momentum source**: pump.fun `sort=last_trade_timestamp` listing (verified live), pre-filtered,
  added beside the launch sources.
- **Honest limit**: only pump.fun bonding-curve buy/sell layouts are proved here, so the floor
  applies to coins still on their curve. Bonded (AMM) coins would need a pump-amm buy layout proved
  against landed transactions.
- Startup guard: `SNIPE_MIN_AGE_HOURS` below the feed's 30-min dedupe TTL is refused — otherwise
  every momentum candidate is silently dropped as a duplicate.

### 3.4 Volume spike — `executor/snipe-volume.mjs`, gate `volume_spike`
- Net SOL inflow over 30 s vs the 5 min before, fed from gRPC trade events the feed used to drop.
- No-baseline → `null`, never Infinity. Samples are 2-second buckets (one sample per trade let a
  hot coin evict its own baseline). **Ships measure-only** (`SNIPE_MIN_VOLUME_SPIKE` unset).

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
+0.620. #1 agent took 6.196 SOL of fees (43%); the other 25 averaged ~0.33 SOL (~$66). At 30 bps
that is ~$22k of volume for a typical coin, ~$413k for the top one.

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
  rolls back. That is expected; the message now says so.
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

## 6. The review that was in flight

An exhaustive review of PR #45 was running when this was written: six areas (fee claim, fee lane,
market floor, volume spike, config/install, agent pages), two finders per area then
loop-until-dry, every finding judged by three verifiers (reproduce / refute / impact, ≥ 2 of 3 to
survive), then a completeness critic and a round on its gaps.

- The script is committed at **`docs/handoff/review-pr45.workflow.js`**. It is a Claude Code
  Workflow script; re-run it by asking the new session to "run the workflow script at
  docs/handoff/review-pr45.workflow.js" (Workflow tool, `scriptPath`). Its prompts hard-code
  `/home/user/claude-company` as the repo path — change that line if the checkout lives elsewhere.
- If `docs/handoff/review-results.md` exists, the old session committed the results; **fix the
  confirmed findings before merging**. If it does not exist, re-run the review first.
- Two suspicions worth checking first (not yet confirmed): `viewer/fees.html` uses `Buffer.from`,
  which is not a browser global; and it discovers wallet-standard wallets via
  `window.navigator.wallets`, which may not be how the registry works — compare with how
  `viewer/tower.html` does both.

---

## 7. What to do next

**Engineering (the new session):**
1. Get the review results (§6); fix every confirmed finding on this branch; run the full suite;
   push; update PR #45's description.
2. Watch PR #45 until the owner merges it. After merge, the Render deploy is the gate — check it.

**The owner's own steps (these need the owner, not Claude):**
1. **Merge PR #45.**
2. **Upgrade the Mac** at the merged commit: `git pull`, unload using the path the installer
   prints, run `install.sh` again (it detects the prior install and carries settings forward),
   load from the **versioned** path. Every new dial ships off, so the upgrade alone changes nothing.
3. **Turn on what they want**, in the env file:
   ```bash
   FEE_CLAIM=dry
   FEE_CLAIM_CREATOR=3J57tqAJqRmSBn1ZYDu9JpMMyTfBHdcGGwECiPQeiji3
   SNIPE_MARKET_FLOOR=bagwork          # stops buying the population that lost money
   ```
   `SNIPE_MIN_VOLUME_SPIKE` should wait for a scorecard:
   `node ~/claudeco-executor/versioned-releases/<sha>/executor/grade-entry-gates.mjs`.
4. **Claim fees** at `solana.claudedotcompany.com/fees.html` whenever the page says the net is worth it.

**Last known state of the owner's Mac** (unverified since): running release `e6dd559…` with the
shadow book persisting and LaserStream `sgp` armed. PR #43 (`5646b1c`) and PR #45 are not on it.

**Not done, and why:**
- No trading edge was found. Nothing claims one — the volume spike ships unarmed because nobody has
  graded it.
- Per-floor coin launches (a prepare / image / fund / confirm flow) — deferred by the owner's choice.
- A pump-amm buy layout (needed to trade bonded coins) — not proved; needs landed transactions.
