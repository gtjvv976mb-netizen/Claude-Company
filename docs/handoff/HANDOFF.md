# Handoff — Claude Co / HAWK-AI, as of 2026-10-09

**New session on another account: read `docs/handoff/START-HERE.md` first** — it is the message
the owner pastes to start you, and it says what to do in your first hour.

Written 2026-10-01 by the Claude Code session `session_01AnSSHGYh96ikWVKhtV8W6s`, and **refreshed
2026-10-09 at about 16:30 UTC by the same session with live reads of the desk and the chain**
(its environment could reach them by then). It exists so that a session on **another Claude
account** can take this work over with nothing but this repository. It replaces the 2026-09-26
handoff; that text is kept at `git show 9f319f5:docs/handoff/HANDOFF.md`, and the facts from it
that are still worth money are carried in §9.

Every live number below says when it was read. The raw reads behind §0, §1 and §5 were the
public `GET /api/heartbeat`, `GET /api/agent/50` and `GET /api/storage` on
`claude-company-api.onrender.com`, plus `tools/wallet-report.mjs` against the burner wallet on
mainnet. Re-read them before acting on any number; a week changed almost all of them.

---

## 0. Read this first — what is true right now (2026-10-09, 16:30 UTC)

1. **HAWK-AI is running but cannot buy: the wallet is empty.** The bot restarted on the owner's
   Mac at 09:43 UTC today, both lanes are armed (launch lane `execute`, trend lane `live`), the
   feed is 4/4 live — and every buy since has been refused as `low_balance`. The wallet holds
   **0.0278 SOL**; a launch ticket is 0.1 SOL, a trend ticket 0.05, and 0.01 is kept back for
   exits. The last real trade on either lane was **2026-10-07 09:58 UTC**. Nothing in this
   repository can fund or stop the bot; only the owner and the Mac can (§4.4).
2. **The money record is negative everywhere it is measured.** HAWK-AI's journal: 492 closed
   trades, 87 won, **−3.33 SOL**. The whole wallet's risk ledger since 2026-09-12: **−4.57 SOL**
   realized on 65.5 SOL deployed. The trend lane for real: 136 trades, 17 won, −0.115 SOL. The
   trend lane on paper since 2026-09-28: 14% win rate and negative for both kinds (variants
   −2.93 SOL over 1,351 trades). No strategy in this repo has shown an edge. Say so plainly
   to the owner before building anything that spends.
3. **The stuck graduated coin is gone**, sold by hand through Jupiter on 2026-10-02 (§5.2), and
   **PR #56 is merged**: the launch lane now sells before a curve graduates, backs off a failing
   sell, and marks an unsellable one SELL BY HAND. It reaches the Mac only when the owner
   upgrades (§7).
4. **The desk's research is off** (its public state reads `INACTIVE`, $0 spent today): the
   Anthropic key is disabled, so it publishes no calls. That is the owner's decision.

---

## 1. Where things stand

| | |
|---|---|
| **Repo** | `gtjvv976mb-netizen/Claude-Company` — the desk and the executor. *Not* `Claude-Company-Solana`, which only republishes the site from this repo's `main` on a schedule and holds none of this work. |
| **`main`** | The merge of PR #56, 2026-10-09 (this file, the handoff tools, and the launch lane's exit fix). A merge to `main` deploys the desk on Render and, through `.github/workflows/pages.yml`, runs `npm test` and rebuilds the public site. There is no PR CI. |
| **Branches** | All work is on `main`. `claude/practical-rubin-n5w92k` (this session) and `claude/eloquent-mayer-3jwcyb` (the previous one) are fully merged. A new session develops on whatever branch it is given; the owner merges to `main` with merge commits. |
| **Open PRs** | [#44](https://github.com/gtjvv976mb-netizen/Claude-Company/pull/44) "HAWK-AI for Phantom, and stock-quoted launches in the executor" — open since 2026-09-24, base `5646b1c`, far behind `main`. It is the CoinMarketCat / Cat Intelligence Agency work the owner parked (its last commit moves that product to its own repo). Not merged, not rebased, not this session's. Nothing else is open. |
| **The Mac** (read 2026-10-09 16:29 UTC) | Heartbeat 21 s old, `live: true`. HAWK-AI up since 09:43 UTC today, `mode: execute`, `state: up`, no faults, no open positions. Since that restart: 17,150 launch notices, 17,121 refused, 0 bought, 29 buys refused `low_balance`; trend lane 39 signals, 0 bought, 39 refused `low_balance`. Feed 4/4 live (`logs`, `poll-list`, `grpc`, `poll-momentum`), trade tape live; the gRPC watchdog has restarted the stream 64 times in under 7 hours. The desk-call lane (WALL-ST-E) is `degraded` with entries off. It runs a release from before PR #56. |
| **Wallet** (burner, read on chain 2026-10-09 16:31 UTC) | **0.027811 SOL.** 12 empty token accounts hold 0.018 SOL of rent (`executor/reclaim-rent.mjs --send` gets it back). Two dust holdings of Backpack Securities tokenized stocks, NIKE (≈ $0.30) and SpaceX (≈ $0.76), that neither lane buys — origin not established. Its address is deliberately not in this public repo (§5.3 says how to get it). |
| **Tests** | `npm test` (`node scripts/test-all.mjs`): 197/197 files passed on 2026-10-01 at the PR #56 code commit. |

---

## 2. Setting up on a new account

- **Repository access.** The repo is **public**, so any account can read and clone it. To push
  and open PRs, the new account's Claude must be connected to a GitHub user with write access.
  Today the only collaborator is the owner's own GitHub user, `gtjvv976mb-netizen`. If the new
  Claude account connects **the same GitHub user** (https://claude.ai/connect-github), nothing
  else is needed. If it connects a **different** GitHub user, the owner must first add that user
  under the repo's Settings → Collaborators. Either way the Claude GitHub App must be installed
  on the repo (same page). Start the session with this repo selected; a session's repositories
  are chosen when it starts.
- **Network.** On 2026-10-01 this session's cloud environment denied every host the work needs;
  by 2026-10-09 it allowed them. A new environment starts with its own policy: in its settings
  (Edit → Network access) choose a broader level or allow these hosts: `claude-company-api.onrender.com` (the desk's API), `claudedotcompany.com` and
  `solana.claudedotcompany.com` (the sites), `frontend-api-v3.pump.fun`, `api.dexscreener.com`,
  and a Solana RPC (`api.mainnet-beta.solana.com`, or the owner's private one — never print
  it). Without this a session can read code and nothing else.
- **No secret is needed to read.** `GET https://claude-company-api.onrender.com/api/heartbeat`
  is the desk's health; `GET https://claude-company-api.onrender.com/api/agent/50` is HQ's
  agent page data, and because floor 50 is HQ it carries the bot's `snipe` block raw (§4.3).
  Changing the bot's filters from the page needs the owner's wallet session; stopping the bot
  needs the Mac.
- **Before running tests** in a fresh container: `npm ci && npm ci --prefix executor
  --ignore-scripts` (the npm registry is reachable even when nothing else is).

---

## 3. Standing rules — the owner set these; keep them

- Develop on the branch the session was given. The **owner merges** to `main`; do not merge
  unless the owner says so in as many words (they did for PR #56: "merge"), and do not open a PR
  unless the owner asked for one (they have, for every piece of work so
  far — "commit, push and open the PR" is the normal close of a task).
- **Never print or handle secrets** (`CC_SECRET`, private keys, RPC and gRPC tokens, the burner
  key). The owner's env values are double-quoted; strip with `tr -d '"'` when reading one.
- **Never disable TLS verification or unset `HTTPS_PROXY`.** Chromium cannot reach public HTTPS
  through the cloud sandbox's proxy: serve downloaded pages over local HTTP instead.
- **Money actions need the owner's explicit say-so**: arming a lane, raising a cap, selling a
  position by hand, launching a coin, funding a wallet, signing anything. Nothing in this
  system signs a creator-fee claim; the owner does (§9).
- Never put model identifiers in commits, PR bodies or code beyond the attribution lines.
- The owner writes short, often all-caps instructions ("DO IT", "continue"). Read them as
  "proceed with the obvious next thing"; they have consistently wanted work done rather than
  discussed, with the result reported plainly, outcome first.
- When the owner reports a number from their Mac or their wallet, measure it before explaining
  it: every fix in PRs #47–#50 came from reading the chain, not the log.

---

## 4. The system in one page

### 4.1 The desk (Render)
`src/` — Node, SQLite, served from `claude-company-api.onrender.com`; the static site at
`claudedotcompany.com` is built from `viewer/` by `scripts/build-viewer.mjs`. The research
pipeline (DESK.md) forms unsigned trade proposals; with the Anthropic key disabled it currently
produces none (§0.3). `src/office.js` holds the routes; `/api/heartbeat` is the desk's own
state; `/api/agent/:floor` is the public agent page's data; `/api/storage` the last hourly
storage report; `/api/fees/claimable` the creator-fee read. The desk never signs.

### 4.2 The executor on the owner's Mac
`executor/` — one LaunchAgent (`com.claudeco.wallste`) running `poller.mjs` from
`~/claudeco-executor/versioned-releases/<full-sha>/executor/`, env in
`~/claudeco-executor/.cc-executor.env` (0600), journal at
`~/claudeco-executor/.cc-executor.sqlite`, log at
`~/Library/Logs/ClaudeCompany/wallste.stdout.log`. One burner wallet
(`~/claudeco-executor/burner.json`), one journal, one signing port for everything that is pump.fun
(`snipe-execute.mjs`). Three lanes ride it:

| lane | switched on by | signs? | what it does |
|---|---|---|---|
| **Launch lane** (HAWK-AI proper) | `SNIPE_LANE=execute` + the typed `SNIPE_LIVE_ACK` | yes | buys coins the market floor admits (`SNIPE_MARKET_FLOOR`, `SNIPE_RISK_MODE`, the `SNIPE_MIN_*` filters), sells in full at the take, the stop, the creator's exit or the clock. `snipe-lane.mjs`. |
| **Trend lane** | `SNIPE_TREND=shadow` or `live`, `SNIPE_TREND_KINDS` | live: yes | follows coins launched *about* a runaway coin (variants / subtopics of a parent whose ATH hit $1M within 12 h). Paper always (`snipe-trend.mjs`); in `live`, `snipe-trend-live.mjs` buys the strategy's kinds for real through the same port, 0.05 SOL a ticket, 2 open, 0.15 SOL/24 h loss stop, graduation guard at 75 SOL of curve reserve. |
| **Fee lane** | `FEE_CLAIM=dry` + `FEE_CLAIM_CREATOR` | never | reads the `$CLAUDECO` creator vaults and books what is claimable to `<state-db>.fees.jsonl`; the owner signs the claim at `/fees.html`. `fee-lane.mjs`. |

The feed: pump.fun program logs over the RPC WebSocket plus the listing poll, and the Yellowstone
gRPC stream (`SNIPE_GRPC_URL/TOKEN/COMMITMENT`, Helius LaserStream region `sgp`) that feeds the
trade tape (`snipe-volume.mjs`) which `recent_trades` and `volume_spike` are measured on. A
watchdog (`createSourceWatchdog` in `snipe-feed.mjs`, timings in its `GRPC_WATCHDOG` constant —
not an env var) restarts the gRPC source when it dies.

All dials the lanes read are in one table, `SNIPE_ENV` in `executor/snipe-lane.mjs`;
the launchd runner's `ALLOWED_ENV` and the installer's upgrade carry loop must name every one of
them (§10).

### 4.3 What the heartbeat says, and where to read it
The bot posts a heartbeat to the desk once a minute. `GET /api/agent/50` returns it sanitized
(`sanitizeExecutorSnipe` in `src/office.js`), with these fields worth knowing:

- `live` — true only when the heartbeat is under 150 s old **and** `snipe.state === "up"`.
- `snipe.state` — `up`, `faulted` (retrying with a position open), `disabled`,
  `failed-to-start` (a bad `SNIPE_*` value; `lastError` has the bot's reason).
- `snipe.open[]` — every open launch-lane position: `mint`, `sizeSol`, `entry`, `openedAt`,
  `high`, and — from PR #56 on — `exitAttempts`, `exitError`, `exitBlocked` (`"graduated"` =
  sell by hand) and `exitLatchedAt`. **A Mac release from before PR #56 sends none of the exit
  fields**: a stuck sell then shows up only as `counts.exitFailures` climbing by one per tick,
  and the clause is only in the Mac log.
- `snipe.counts` — `entered`, `exited`, `entryFailures`, `exitFailures`, `reconciled`,
  `refused`, `marketReadsSkipped`, and from PR #56 `exitBlocked`.
- `snipe.flow` — `tradeFeedLive` (false = the gRPC tape is down and every trade floor refuses
  as `trade_feed_down`), `grpcRestarts`, `grpcLastRestartError`.
- `snipe.lastEntryFailure` — `clause` + `message` of the last refused buy (`low_balance`,
  the program's `6002 TooMuchSolRequired`, …).
- `snipe.remote` — whether page-set filters are on and which saved version the bot runs.
- `snipe.trend` — the trend lane's paper scorecard (`strategy` vs `comparison` tallies) and,
  in live mode, `trend.live` (open book, `closed`, `wins`, `losses`, `realizedSumSol`,
  `realized24hSol`, `lossStop`, `lastError`, `recent[]`), plus `trend.detector` (the parent
  finder's refreshes, failures and `lastError`).
- `snipe.book` — HAWK-AI's lifetime record from the journal (`trades`, `wins`, `losses`,
  `realizedSol`, the 20 latest `closed` rows). Both lanes sign through one port, so trend-live
  trades are in it too.
- `feeLane` — the fee lane's block, never summed with trading. The desk's own
  `/api/heartbeat` also carries `houseBot`: the same bot seen from the desk, with the whole
  wallet's risk `ledger` (every lane).

### 4.4 How it is stopped — on the Mac only
```bash
bash ~/claudeco-executor/current/macos-launchagent.sh buys off     # no new buys, either lane; open positions still exit
bash ~/claudeco-executor/current/macos-launchagent.sh buys status
bash ~/claudeco-executor/versioned-releases/<full-sha>/executor/macos-launchagent.sh unload   # stop the process (writes the entry pause)
touch ~/claudeco-executor/HARD_STOP                                                            # HARD_STOP: no new submissions at all, exits included
```
`buys off` is the switch to reach for. `HARD_STOP` blocks sells too, so a position open under it
has no stop until it is lifted. The pause file, `~/claudeco-executor/PAUSE_ENTRIES` (the
installer writes both paths into the env file as `PAUSE_ENTRIES_FILE` and `HARD_STOP_FILE`), is
also created by every install, every `unload`, and by the supervisor whenever the Mac is on
battery. Stopping the process never closes an on-chain position.

---

## 5. Live state in detail (read 2026-10-09, 16:29–16:31 UTC)

### 5.1 The trend lane
- **For real** (`SNIPE_TREND=live`, `SNIPE_TREND_KINDS=variant`, since 2026-09-30): **136 closed
  trades, 17 won, 119 lost, −0.115 SOL.** Last real trade 2026-10-07 09:58 UTC. The 0.15 SOL/24 h
  loss stop is not active; the lane is simply out of money (39 `low_balance` refusals since the
  restart).
- **On paper** (since 2026-09-28): variants 1,351 trades, 14% won, −2.93 SOL; subtopics (the
  control) 2,395 trades, 14% won, −3.67 SOL. The early "variants are ahead" reading (§9) did not
  survive the sample.
- **Unexplained, worth a look before anyone trusts this lane again:**
  - Four real trades closed as `trail: 25% off a 35x–259x peak` and still lost about 4% each
    (FOMOCAT twice, GPU, BPCATE, 2026-10-03 to 10-07). A real 35x peak cannot end in a loss on
    a 25% trail, so the peak was almost certainly a mis-priced trade print, and the trail then
    fired at once.
  - The last real fills cost about 0.0136 SOL each against a configured 0.05 SOL ticket.
- **The parent detector is being rate-limited**: 74 of 82 refreshes of pump.fun's listing
  failed with HTTP 429; the last good one was 14:09 UTC. It keeps the last good 23 parents, so
  the lane still runs, on a stale list.

### 5.2 The stuck graduated position — resolved
- The launch lane bought `26QftJYy746GCx6wnV8vMkJRErCtyhChM8hBxY6Hpump` at 15:49:36 UTC on
  2026-09-30 for 0.0998 SOL. The coin completed its curve and moved to PumpSwap; every sell was
  refused at the port (`snipe-execute.mjs`: "the curve has graduated — the position must leave
  through a pool route, which this path does not build; sell by hand"), and the lane retried
  every tick — 6,196 times by 2026-10-01.
- **It was sold through Jupiter at 05:55:24 UTC on 2026-10-02**: 241,205 tokens for 0.005856 SOL,
  about −0.094 SOL on the position. Neither HAWK-AI lane routes through Jupiter, so this was a
  hand sale with the burner key (a wallet app, or `executor/sell-back.mjs`). The lane then saw
  the wallet holding none and closed the row through its reconcile path (the only way a live row
  closes without a fill); nothing is open now.
- PR #56 (merged 2026-10-09) is the fix, so it cannot recur silently: a graduation guard at
  75 SOL of curve reserve, a 2 s → 30 s backoff, and a terminal SELL BY HAND state on the
  heartbeat and both pages. `executor/test-snipe-exit-stuck.mjs` pins it.

### 5.3 The wallet
- **0.027811 SOL** on 2026-10-09 16:31 UTC (`tools/wallet-report.mjs`, public RPC). The bot's own
  refusal agrees to the lamport: its message says the buy "would leave −72,188,728 lamports",
  and the launch ticket is 100,000,000.
- Path since the last handoff: 0.216 SOL on 2026-10-01 → trades → a **0.030 SOL plain transfer
  out** on 2026-10-03 15:12 UTC (a System-program transfer, not a trade) → 0.0278 now.
- 12 empty token accounts hold 0.018 SOL of rent. `node executor/reclaim-rent.mjs` on the Mac
  lists them; `--send` closes them. That is the owner's call (it signs).
- Two token-2022 dust holdings, both Backpack Securities tokenized stocks on Raydium: NIKE (NKE)
  0.008673 ≈ $0.30, SpaceX (SPCX) 0.004667 ≈ $0.76. Neither lane buys stock tokens; where they
  came from is not established.
- **Finding the burner address.** It is deliberately absent from this public repo and from
  every public endpoint. Ask the owner (it is printed in the Mac's log at boot and shown on the
  owner's executor status page), or read it off the chain: it is the signer of any sell in
  `snipe.book.closed` — `getSignaturesForAddress` on that row's mint, the transaction within
  about 10 s before its `closedAt`.

### 5.4 The desk
- Research is off: public state `INACTIVE`, today's spend $0 of the $200 cap, no calls. All-time
  research spend $934.42; the desk's own settled calls are 2, both losses (−$0.42).
- Storage (hourly report, 15:30 UTC): database file 1.43 GB of which **1.08 GB is free pages**
  inside the file — the trim works, but SQLite does not shrink a file without `VACUUM`. The disk
  is 27.5% used of 5 GB. Largest tables by rows: `forward_marks` 462k, `chronicle` 200k,
  `snapshots` 163k, `decision_runs` 102k. The trim's last pass deleted nothing new.
- `/api/storage` serves the last report; `node src/index.js storage` walks bytes per table
  (never inside the API process: on the first boot of `91dd82c` that blocked the API for over a
  minute).

---

## 6. What was merged since the 2026-09-26 handoff (PRs #45–#56)

| PR | merged | what it is |
|---|---|---|
| [#45](https://github.com/gtjvv976mb-netizen/Claude-Company/pull/45) | 09-27 | Everything BAGWORK runs on: creator-fee claim (owner-signed), fee lane, market floor, volume spike, agent pages / levels / rewards / strategy builder, plus the review's ~25 fixes. Full account in the 2026-09-26 handoff (`git show 9f319f5:docs/handoff/HANDOFF.md`, §3 and §6). |
| [#46](https://github.com/gtjvv976mb-netizen/Claude-Company/pull/46) | 09-27 | **Filters from the agent page** (`SNIPE_REMOTE_FILTERS=1`): the floor's owner changes *what to buy* (floor preset and thresholds, spike, socials, creator/launch share caps) and the bot applies them within a minute, no restart. Money, exit, pricing and mode values are refused by name (`LIVE_FILTER_ENV`); a stolen session can only make the bot pickier or looser inside the Mac's caps. |
| [#47](https://github.com/gtjvv976mb-netizen/Claude-Company/pull/47) | 09-27 | **Risk modes** `SNIPE_RISK_MODE` = `veteran` / `proven` / `wave` / `early` (bundles of entry filters, the desk's copy asserted equal to the executor's). **`SNIPE_ENTRY_SLIPPAGE_BPS`** (default 300): the owner's first 43 live buys all failed in simulation with pump.fun `6002 TooMuchSolRequired` because the ceiling was the exact cost at read time; room now comes out of the *quantity*, spend is still capped at the ticket. The last buy failure rides the heartbeat. |
| [#48](https://github.com/gtjvv976mb-netizen/Claude-Company/pull/48) | 09-27 | **What the first 46 live market-floor trades taught** (4 W, 42 L, −0.19 SOL): 30 sold at exactly their buy price (nobody traded) → `SNIPE_MIN_RECENT_TRADES` off the gRPC tape; the sell never closed the token account (47 empty accounts, 0.07 SOL of rent) → the sell closes it in the same transaction; a buy spent the wallet to 0.00067 SOL and the exit could not pay its fee (365 failed sells) → `SNIPE_MIN_WALLET_RESERVE_SOL` (0.01); launch exits (90 s stall, 3 min clock) sold every hour-old coin on the clock → with a market floor and no exit timing typed, a 10 min time stop and no stall exit. |
| [#49](https://github.com/gtjvv976mb-netizen/Claude-Company/pull/49) | 09-28 | **The gRPC feed died and nothing revived it**: nine hours of every candidate refused as "0 trades in 5 minutes". `createSourceWatchdog` (15 s → 5 min backoff), `tradeFeedStatus` (down → `trade_feed_down`, five minutes after a reconnect → `trade_feed_warming`, the spike withdrawn), and the lane's own reads no longer evict real history from the 2,000-mint tape (6,511 evictions observed). |
| [#50](https://github.com/gtjvv976mb-netizen/Claude-Company/pull/50) | 09-29 | **The trend lane, shadow** (`SNIPE_TREND=shadow`): parents = pump.fun coins whose ATH reached $1M within 12 h of launch, within the last day; related launches matched on name/ticker/description words (variants and subtopics; exact clones skipped; a key matching 25+ launches an hour is generic); lottery exits (−25% stop, cut if not +10% in 3 min, a winner past +30% rides and leaves 25% off its peak, 1 h max). Rows to `<state-db>.trend-shadow.jsonl`. |
| [#51](https://github.com/gtjvv976mb-netizen/Claude-Company/pull/51) | 09-30 | **`SNIPE_TREND_KINDS`** (`all` / `variant` / `subtopic`): first 103 paper trades had variants +0.017 SOL (5 of 19 won) and subtopics −0.223 (11 of 84), so the strategy became variants with subtopics as the control; the scorecard survives restarts (newest 5,000 rows seeded back). **Server disk care**: storage report, hourly `wal_checkpoint(TRUNCATE)`, `journal_size_limit` 64 MB, `/api/storage`, the 5 GB disk in `render.yaml`. |
| [#52](https://github.com/gtjvv976mb-netizen/Claude-Company/pull/52)–[#54](https://github.com/gtjvv976mb-netizen/Claude-Company/pull/54) | 09-30 | Storage: the hourly check made cheap (rowid estimates, no page walk); the hourly trim of day-old `insufficient_coverage` decisions; the trim's foreign-key order fixed (it had deleted nothing on its first run). |
| [#55](https://github.com/gtjvv976mb-netizen/Claude-Company/pull/55) | 09-30 | **`SNIPE_TREND=live`**: `snipe-trend-live.mjs` buys the strategy's kinds for real through the sniper's port; needs `SNIPE_LANE=execute`; paper lane keeps running as the comparison; its own limits (`SNIPE_TREND_TICKET_SOL` 0.05, hard cap 0.5; `SNIPE_TREND_MAX_OPEN` 2; `SNIPE_TREND_MAX_DAILY_LOSS_SOL` 0.15); graduation guard at 75 SOL; failed sells retried on a 2–30 s backoff and reconciled only on a definite zero; book in `<state-db>.trend-live.json`, closed trades in `<state-db>.trend-live.jsonl`; `trend.live` on the heartbeat. |

| [#56](https://github.com/gtjvv976mb-netizen/Claude-Company/pull/56) | 10-09 | **This handoff, its tools, and the launch lane's exit fix**: `GRADUATION_GUARD_SOL` 75 (sell before the curve completes), `exitRetryDelayMs` 2 s → 30 s, `blockExit`/`stepBlocked` (a graduated position is marked SELL BY HAND, never retried, closed only when the wallet no longer holds it); `open[]` on the heartbeat carries `exitAttempts`, `exitError`, `exitBlocked`, `exitLatchedAt`; the HAWK-AI tab and the agent page show it. Merged by this session on the owner's explicit "merge". |

PRs #45–#55 were written by the previous session (`session_01F71n8BkTmDSf7vg3XzRX3p`), #56 by
this one. The Mac ran #55 when this file was refreshed; #56 reaches it at the owner's next upgrade.

---

## 7. What to do next

**The owner's decisions first — nothing below spends until these are made:**
1. **Fund the wallet, or stop the lanes.** At 0.0278 SOL both lanes refuse every buy. Funding
   it restarts real-money trading on a record that is negative on every lane (§0.2). Stopping
   is `buys off` on the Mac (§4.4), or `SNIPE_TREND="shadow"` (edit the line in place; a second
   `SNIPE_TREND` line stops the bot at launch) to keep only the paper scorecard.
2. **Upgrade the Mac to `main`** so the PR #56 exit fix runs (steps below). With no open
   positions there is no hurry, but it must be on before the next real buy.
3. **Reclaim the rent**: `node executor/reclaim-rent.mjs --send` on the Mac returns about
   0.018 SOL from 12 empty token accounts. It signs, so it is the owner's act.
4. The two tokenized-stock dust holdings (§5.3): explain or ignore.
5. Re-enable the desk's Anthropic key, or leave research off. Until it is on, the desk makes no
   calls and the WALL-ST-E lane has nothing to take.
6. PR #44: close it or ask for a rebase. It belongs to the parked CoinMarketCat product.
7. Fee claim at `solana.claudedotcompany.com/fees.html` when the page says the net is worth it.
   Today it is not: 0.00133 SOL claimable, below the floor on all 14 passes.

**Engineering (propose, build, PR — no money moves):**
1. **The trend lane's impossible peaks**: find why four real trades recorded 35x–259x peaks and
   lost (§5.1). Start at `priceOfTrade` in `executor/snipe-trend.mjs` and the live lane's
   `onTrade` in `snipe-trend-live.mjs`. A print in a different quote or a decimals mismatch is
   the first suspect; a test that replays such a print should fail first.
2. **The fill size**: why real trend fills were ~0.0136 SOL against a 0.05 ticket.
3. **The parent detector's 429s**: back off and spread its listing reads (`createTrendDetector`
   in `snipe-trend.mjs`); 74 of 82 refreshes failed today.
4. **gRPC churn**: 64 watchdog restarts in under 7 hours. Read `grpcLastRestartError` and the
   Mac log before changing the watchdog's timings (`GRPC_WATCHDOG` in `snipe-feed.mjs`).
5. **Grade before arming anything new**: `tools/trend-study.mjs` on the Mac's two JSONL files
   gives real-vs-paper on the same coins.

**Upgrading the Mac** after a merge (the owner does this; the steps are the installer's):
`git pull`; `unload` from the versioned path; run `install.sh` again (it detects the prior
install and carries settings forward; "release already exists" at the same commit is expected
and means the bot is stopped); `load` from the **versioned** path; then `buys on` or
`rm ~/claudeco-executor/PAUSE_ENTRIES` once the log shows the lanes up.

---

## 8. The tools in `docs/handoff/tools/` — zero dependencies, Node 18+, read-only

They need network (a Solana RPC, pump.fun, DexScreener), so they run on the Mac, on any laptop,
or in a cloud session whose environment allows those hosts (§2). None of them imports
`@solana/web3.js`, so they run from any directory and never need `executor/node_modules`.

| tool | run | answers |
|---|---|---|
| `wallet-report.mjs` | `node docs/handoff/tools/wallet-report.mjs <WALLET> [--rpc URL] [--limit 50] [--json]` | balance; every token held (a non-zero balance is a position); empty token accounts holding rent (then `executor/reclaim-rent.mjs`); the last N transactions with the wallet's own SOL change, fee, venue (pump.fun curve / PumpSwap / Jupiter), token moved, failed-or-not; the window's net SOL and the fees burned by failures. Only the RPC's hostname is ever printed. |
| `trend-study.mjs` | `node docs/handoff/tools/trend-study.mjs [--dir ~/claudeco-executor] [--since 24h] [--json]` | the paper and the real trend books: wins/losses/P&L, by kind, by exit reason, by parent, by day; strategy vs comparison; **paper vs real matched by mint** (the cost of being real). Finds the two JSONL files under the install dir, or take `--state-db`, `--shadow`, `--live`. |
| `stuck-position.mjs` | `node docs/handoff/tools/stuck-position.mjs <MINT> [--wallet WALLET] [--rpc URL] [--json]` | is the curve complete, which pool it graduated to, where it trades and at what price, how much the wallet holds and what that is worth — and the verdict: on the curve (the lane sells it) or graduated (no bot path; by hand or leave it). |

`wallet-report.mjs` was run live against the burner on 2026-10-09 and matched the bot's own
balance to the lamport; that run found that wallet apps send version-1 transactions, which the
first version refused, and it now reads them. `stuck-position.mjs` and `trend-study.mjs` were
exercised against a mock RPC and a synthetic JSONL fixture. The public RPC rate-limits hard: for
more than ~40 transactions pass the owner's private `--rpc`. A mint or wallet must be 32–44
base58 characters or the usage line is printed.

---

## 9. Facts measured earlier — reuse, don't re-derive

**The owner's sniper record before the market floor (64 real trades):** −0.361 SOL, 5 winners.
Entries < 3 s: 0% win, −18.5%. Entries ≥ 10 s: 40% win, +34.0%. No entry signal ordered the
outcome. pump.fun fees 95 bps protocol + 30 bps creator = 1.25%/side; fees ≈ 45% of the average
loss. **The first 46 market-floor trades** (2026-09-26/27): 4 W, 42 L, −0.19 SOL; a flat trade
still cost 4.1% (2.4% venue, 0.2% network, 1.5% rent — the rent is now returned).

**Trend lane on paper**: first 103 trades, variants +0.017 SOL (5 of 19), subtopics −0.223
(11 of 84); 178 trades to 2026-09-30, variants −0.038 SOL. By 2026-10-09 both kinds were
clearly negative (§5.1). In the 29-minute sample that prompted
the lane, related launches reached ~$30k 2.2x as often as other launches.

**BAGWORK (26 agents, 362 closed trades):** trading −0.077 SOL, creator fees +14.515, rewards
+0.620. The #1 agent took 6.196 SOL of fees (43%); the other 25 averaged ~0.33 SOL. The business
is the creator fee, not the trading.

**`$CLAUDECO`:** mint `HRkkxgaFDDmZ3qZX8xP5SiMRBNvFNVUUv4FJUjPCpump`, bonded, creator
`3J57tqAJqRmSBn1ZYDu9JpMMyTfBHdcGGwECiPQeiji3` (**the owner holds this key; it never goes on the
Mac; `FEE_CLAIM=live` is refused permanently**). Two vaults, two programs: bonding curve
`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`, seed `["creator-vault", creator]` (hyphen); pump-amm
`pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`, seed `["creator_vault", creator]` (underscore). On
2026-09-26 ~0.00707 SOL was claimable after rent. Rent reserve is **650,240 lamports**,
measured — an earlier draft had 890,880 from memory.

**Market floor:** `SNIPE_MARKET_FLOOR=bagwork` admits nothing on a curve (a curve graduates at
85.005 SOL, ~$10k, so $30k liquidity / $50k cap are unreachable); **`curve`** is the preset to
run. Only pump.fun bonding-curve layouts are proved; bonded coins cannot be traded by this
executor. SOL/USD was $121.69 on 2026-09-26 (the dollar figures above are at that price).

**LaserStream:** region `sgp` (94 ms from the owner's Mac), `processed` commitment.

---

## 10. Traps — each has already cost time

- **Never `load` through `current`.** `pwd -P` resolves the symlink and the rendered plist cannot
  match the installed one. Load from
  `~/claudeco-executor/versioned-releases/<full-sha>/executor/macos-launchagent.sh`. It took the
  bot down on 2026-09-18. `buys`, `status` and `unload` work either way.
- **Re-running the installer at the same commit fails** ("release already exists") and rolls
  back; that is expected, and the bot is *stopped* at that point.
- **The runner refuses an env file that names a variable twice.** Change a line in place
  (`sed -i '' 's/^SNIPE_TREND="shadow"$/SNIPE_TREND="live"/' ~/claudeco-executor/.cc-executor.env`);
  appending stops the bot at launch. The file must stay mode 0600.
- **A new runtime module must be registered in seven places**: `install.sh` (source_file loop
  **and** `RUNTIME_FILES`), `macos-release.sh` `RUNTIME_PATHS`, `scripts/build-viewer.mjs`
  `EXECUTOR_FILES`, `executor/heartbeat-health.mjs` fingerprint, `executor/launchd-runner.mjs`
  file list (+ `ALLOWED_ENV` for env vars), `executor/test-install.mjs`,
  `executor/test-launchd.mjs` fixture. A new env dial: `SNIPE_ENV`, `ALLOWED_ENV` **and** the
  `install.sh` upgrade carry loop, and the desk's sanitizer if it rides the heartbeat.
- **Lane modules must be dynamic imports** inside `poller.mjs`'s `SNIPE_LANE !== "off"` branch
  (`test-snipe-wiring.mjs` forbids static imports).
- **`@solana/web3.js` resolves only from `executor/node_modules`.** Ad-hoc scripts that need it
  must live inside `executor/`; the handoff tools avoid it on purpose.
- **`Number(null) === 0`** has produced a confident wrong zero three times in this subsystem.
  Absent check first, always. A close the bot cannot price is "not read", never zero.
- **Before PR #56, the heartbeat's `open[]` carried no exit error** (§4.3). On older releases a stuck sell is visible only as `counts.exitFailures` climbing; the
  clause is in the Mac log
  (`tail -f ~/Library/Logs/ClaudeCompany/wallste.stdout.log | grep -i "exit failed\|sell by hand"`).
- **Stale tracking refs** can fake a conflict; `git ls-remote origin` before believing one.
- **This repo runs no PR CI.** The gates are Render's `npm ci && npm ci --prefix executor
  --ignore-scripts && npm test` and `pages.yml`'s `npm test`, both on `main` after merge.
- **The full suite** (`node scripts/test-all.mjs`, ~7–10 min): if `node_modules/playwright` is
  present the suite trips on it — move it aside for the run.
- **A cloud session's network is closed by default.** Everything beyond GitHub and npm was
  denied in the environment this file was written in (§2). Check with one `curl` before
  planning work that reads the desk or the chain.
- **The previous handoff said PRs are squash-merged.** They are not: `main` carries merge
  commits with every branch commit beneath them. Bisect accordingly.
