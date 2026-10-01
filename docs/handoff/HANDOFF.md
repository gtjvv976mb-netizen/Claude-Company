# Handoff — Claude Co / HAWK-AI, as of 2026-10-01

Written 2026-10-01 (about 03:00 UTC) by the Claude Code session `session_01AnSSHGYh96ikWVKhtV8W6s`
on branch `claude/practical-rubin-n5w92k`, so that a session on **another Claude account** can
take this work over with nothing but this repository. It replaces the 2026-09-26 handoff; that
text is kept at `git show 9f319f5:docs/handoff/HANDOFF.md`, and the facts from it that are still
worth money are carried in §9.

How it was made, so you can weigh it: the previous session (`session_01F71n8BkTmDSf7vg3XzRX3p`,
the one that wrote PRs #45–#55) read the live desk and the chain at about 02:40 UTC today and
drafted this file; its container was then lost before anything was committed, and this session
rebuilt it from the repository and that session's own progress notes. **This session's cloud
environment could not reach the desk, Solana RPC, pump.fun or DexScreener (network policy), so
every live number in §1 and §5 is the previous session's reading and has not been re-checked.**
§2 says how to give a new session that reach. Read all of this before touching anything.

---

## 0. Read this first — three things that are true right now

1. **HAWK-AI is trading real money on the owner's Mac, on two lanes**: the launch lane
   (`SNIPE_LANE=execute` behind a market floor) and, since 2026-09-30, the trend lane in live
   mode (`SNIPE_TREND=live`, variants only). Nothing in this repository can stop it; only the
   Mac can (§4.4). Every merge to `main` changes what the Mac will run at its next upgrade.
2. **One launch-lane position is stuck** on a coin that graduated off its pump.fun curve. The
   bot has retried the sell every tick since about 15:49 UTC on 2026-09-30 (6,196 failures at
   the last reading) and cannot succeed: the curve sell path refuses a completed curve by
   design, and the executor builds no pool route. Worth about $0.75. §5.2 explains it; §7 says
   what to do.
3. **The desk's Anthropic key is disabled**, so the research pipeline writes an
   `insufficient_coverage` decision for every coin (about 19,000 a day) and publishes no calls.
   Storage is under control (hourly trim, §5.4), but the desk is not doing research. Reversing
   that is the owner's decision, not yours.

---

## 1. Where things stand

| | |
|---|---|
| **Repo** | `gtjvv976mb-netizen/Claude-Company` — the desk and the executor. *Not* `Claude-Company-Solana`, which only republishes the site from this repo's `main` on a schedule and holds none of this work. |
| **`main`** | `e59d35d`, the merge of PR #55, 2026-09-30 16:23 UTC. A merge to `main` deploys the desk on Render and, through `.github/workflows/pages.yml`, runs `npm test` and rebuilds the public site. There is no PR CI. |
| **Branches** | This file: `claude/practical-rubin-n5w92k`. The previous session's `claude/eloquent-mayer-3jwcyb` is fully merged (its tip `ad63902` is on `main`). A new session develops on whatever branch it is given; the owner merges to `main` with merge commits. |
| **Open PRs** | [#44](https://github.com/gtjvv976mb-netizen/Claude-Company/pull/44) "HAWK-AI for Phantom, and stock-quoted launches in the executor" — open since 2026-09-24, base `5646b1c`, 30 commits behind `main`. It is the CoinMarketCat / Cat Intelligence Agency work the owner parked (its last commit moves that product to its own repo). Not merged, not rebased, not this session's. Nothing else is open. |
| **The Mac** (previous session's reading, ~02:40 UTC) | HAWK-AI restarted at 00:45 UTC 2026-10-01 on the latest release (the PR #55 merge). Launch lane armed with a market floor; trend lane live; gRPC feed on Helius LaserStream `sgp`. |
| **Trend lane, live, since that restart** | 33 real trades: 4 won, 29 lost, −0.009 SOL. The 0.15 SOL/24 h loss stop was not reached. |
| **Stuck position** | Launch lane, mint beginning `26QftJYy` (the full mint is `snipe.open[].mint` on `/api/agent/50`), 241,205 tokens ≈ $0.75, graduated to PumpSwap. |
| **Wallet** | 0.216 SOL, down from 0.332 at the previous session's earlier reading. Only about 0.009 of that drop is the trend lane's realized result; the rest (launch-lane trades, the stuck buy, fees) is not broken down anywhere yet — `tools/wallet-report.mjs` (§8) is how to break it down. |
| **Tests** | `npm test` (`node scripts/test-all.mjs`): 193 suites at the last recorded run, 2026-09-30. Not run by this session (no network, no `node_modules`). |

---

## 2. Setting up on a new account

- **Repository access.** Connect GitHub at https://claude.ai/connect-github and make sure the
  Claude GitHub App is installed on `gtjvv976mb-netizen/Claude-Company` (the repo owner does
  that from the same page). Start the session with this repo selected; a session's
  repositories are chosen when it starts.
- **Network.** The cloud environment this file was written in denied every host the work
  needs. In the environment's settings (Edit → Network access) choose a broader level or allow
  these hosts: `claude-company-api.onrender.com` (the desk's API), `claudedotcompany.com` and
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

- Develop on the branch the session was given. The **owner merges** to `main`; do not merge,
  and do not open a PR unless the owner asked for one (they have, for every piece of work so
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

All dials the lanes read are in one table, `SNIPE_ENV` in `executor/snipe-lane.mjs` (line ~435);
the launchd runner's `ALLOWED_ENV` and the installer's upgrade carry loop must name every one of
them (§10).

### 4.3 What the heartbeat says, and where to read it
The bot posts a heartbeat to the desk once a minute. `GET /api/agent/50` returns it sanitized
(`sanitizeExecutorSnipe` in `src/office.js`, line ~513), with these fields worth knowing:

- `live` — true only when the heartbeat is under 150 s old **and** `snipe.state === "up"`.
- `snipe.state` — `up`, `faulted` (retrying with a position open), `disabled`,
  `failed-to-start` (a bad `SNIPE_*` value; `lastError` has the bot's reason).
- `snipe.open[]` — every open launch-lane position: `mint`, `sizeSol`, `entry`, `openedAt`,
  `high`, and — from the release built on this branch on — `exitAttempts`, `exitError`,
  `exitBlocked` (`"graduated"` = sell by hand) and `exitLatchedAt`. **On the release the Mac
  ran at this writing (PR #55) none of the exit fields exist**: a stuck sell shows up only as
  `counts.exitFailures` climbing by one per tick, and the clause is only in the Mac log.
- `snipe.counts` — `entered`, `exited`, `entryFailures`, `exitFailures`, `reconciled`,
  `refused`, `marketReadsSkipped`.
- `snipe.flow` — `tradeFeedLive` (false = the gRPC tape is down and every trade floor refuses
  as `trade_feed_down`), `grpcRestarts`, `grpcLastRestartError`.
- `snipe.lastEntryFailure` — `clause` + `message` of the last refused buy (`low_balance`,
  the program's `6002 TooMuchSolRequired`, …).
- `snipe.remote` — whether page-set filters are on and which saved version the bot runs.
- `snipe.trend` — the trend lane's paper scorecard (`strategy` vs `comparison` tallies) and,
  in live mode, `trend.live` (open book, `closed`, `wins`, `losses`, `realizedSumSol`,
  `realized24hSol`, `lossStop`, `lastError`, `recent[]`).
- `fees` — the fee lane's block, never summed with trading.

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

## 5. Live state in detail (previous session's reading, ~02:40 UTC 2026-10-01)

### 5.1 The trend lane, live
Switched to `SNIPE_TREND=live` on 2026-09-30 with `SNIPE_TREND_KINDS=variant` (PR #55, merged
16:23 UTC); the Mac was upgraded and the bot restarted at 00:45 UTC. By ~02:40 UTC: **33 real
trades, 4 won, 29 lost, −0.009 SOL**. For scale: the same strategy on paper was −0.038 SOL over
178 trades to 2026-09-30, and a real fill pays more than the paper model. The lane stops
buying after 0.15 SOL of realized loss in 24 h and keeps selling; nothing else stops it. Whether
to keep it live is the owner's call, on evidence — `tools/trend-study.mjs` produces the evidence
from the two JSONL files on the Mac, including real-vs-paper on the same coins.

### 5.2 The stuck position — what is happening and why it will not resolve itself
- The launch lane bought `26QftJYy…` at about 15:49 UTC on 2026-09-30, on the curve. The coin
  then completed its curve and moved to PumpSwap. The lane's exit rule fired; every sell since
  has been refused at the port: `snipe-execute.mjs` (line ~772) throws `refused: the curve has
  graduated — the position must leave through a pool route, which this path does not build;
  sell by hand`.
- `snipe-lane.mjs` `exitForReal` (line ~1983) keeps the position, latches the exit
  (`exitLatched`, `exitError` on the book row), and **retries on the next tick, every tick, with
  no backoff** — hence 6,196 failures in about 11 hours, surviving the 00:45 restart because the
  book is durable. It closes the row only when the wallet holds none of the token
  (`walletHoldsNothing`), which will never be true on its own.
- Cost of leaving it: each retry is a curve read and a refused simulation against both RPC
  providers (provider quota, not SOL); the position stays on the board; 241,205 tokens worth
  about $0.75 sit in the wallet. The trend lane made 33 trades with it open, so the shared port
  is not frozen by it. Whether it blocks new *launch-lane* buys is not established — read
  `snipe.lastEntryFailure` and `counts.entered` since 00:45 to tell.
- The trend-live lane already has the two things the launch lane lacks: a **graduation guard**
  (sell at 75 SOL of curve reserve, `snipe-trend-live.mjs` line ~234) and a **backoff** on failed
  sells (2 s → 30 s). That is the engineering fix, §7.

### 5.3 The wallet
0.216 SOL at the reading, from 0.332 earlier in the previous session (same day). The trend
lane accounts for ~0.009 of the 0.116 drop. The remainder is launch-lane results since the
last reading, the stuck position's 0.05 SOL ticket (not realized, so not in any P&L), and fees.
Nobody has reconciled it. The launch lane's own book is on the HAWK-AI tab (read from the
journal, `state='accounted' AND kind='snipe_exit'`), and `tools/wallet-report.mjs` reads the
chain directly. The burner address is **not** in this file or in any public endpoint by
design; it is on the Mac (`burner.json`'s public key, printed in the log at boot) and on the
owner's executor status page.

### 5.4 The desk
- Research is off: `ANTHROPIC_API_KEY` disabled → every cycle writes `insufficient_coverage`
  (~19,000 rows/day, ~10 KB each). The hourly storage job (`src/lib/storage.js`, PRs #51–#54)
  deletes those once a day old (forward marks and simulated outcomes first, then the decision —
  the first version failed on the foreign key). First byte measurement of the 1.38 GB database:
  `decision_runs` 882 MB, `snapshots` 258 MB, `forward_marks` 78 MB, `chronicle` 71 MB. The
  Render disk is 5 GB (filled at 1 GB on 2026-09-29). `/api/storage` serves the last report;
  `node src/index.js storage` walks bytes per table (never inside the API process: on the first
  boot of `91dd82c` that blocked the API for over a minute).

---

## 6. What was merged since the last handoff (PRs #46–#55, all by the previous session)

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

Nothing has been merged since. The owner upgraded the Mac to #55 and the bot has been live on it
since 00:45 UTC.

---

## 7. What to do next

**Engineering (needs no owner decision; propose, build, PR):**
1. **Give the launch lane what the trend lane has** — **built on this branch, in the same PR
   as this file** (`executor/snipe-lane.mjs`: `GRADUATION_GUARD_SOL` 75, `exitRetryDelayMs`
   2 s → 30 s, `blockExit`/`stepBlocked`; the heartbeat's `open[]` now carries `exitAttempts`,
   `exitError`, `exitBlocked`, `exitLatchedAt`; the HAWK-AI tab and the agent page say
   SELL BY HAND; `executor/test-snipe-exit-stuck.mjs` pins all of it). It reaches the Mac at
   the next upgrade; until then the stuck position keeps retrying. After the upgrade the
   stuck row will be marked blocked on its first tick and stop; it closes on its own once the
   owner sells the coin by hand.
2. **Explain the wallet**: run `tools/wallet-report.mjs` with the burner address (from the Mac
   or the owner) and reconcile 0.332 → 0.216 SOL into trend, launch, the stuck ticket and fees.
3. **Grade the trend lane** with `tools/trend-study.mjs` on the Mac's two JSONL files once
   there are a few hundred real trades, and put real-vs-paper on the same coins in front of the
   owner. The question is whether being real costs more than the paper edge was.

**The owner's decisions (these need the owner, not Claude):**
1. The stuck coin: sell it by hand (the key is on the Mac; pump.fun's own page routes graduated
   coins through PumpSwap) or leave it. At $0.75 the honest advice is to leave it until item 1
   above stops the retries.
2. Keep `SNIPE_TREND=live` running, or set it back to `shadow` (edit the line in place with
   `sed -i ''`; a second `SNIPE_TREND` line stops the bot at launch).
3. Re-enable the desk's Anthropic key, or leave research off. Until it is on, the desk makes
   no calls and the WALL-ST-E lane has nothing to take.
4. PR #44: close it or ask for a rebase. It is 30 commits behind and belongs to the parked
   CoinMarketCat product.
5. Fee claim at `solana.claudedotcompany.com/fees.html` whenever the page says the net is worth
   it (§9).

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

All three were written in a container with no network, so they were syntax-checked and
exercised against a synthetic JSONL fixture and a local mock RPC (including the path where
pump.fun and DexScreener do not answer), not against the live chain. The first live run of each
is a test; a mint or wallet must be 32–44 base58 characters or the usage line is printed.

---

## 9. Facts measured earlier — reuse, don't re-derive

**The owner's sniper record before the market floor (64 real trades):** −0.361 SOL, 5 winners.
Entries < 3 s: 0% win, −18.5%. Entries ≥ 10 s: 40% win, +34.0%. No entry signal ordered the
outcome. pump.fun fees 95 bps protocol + 30 bps creator = 1.25%/side; fees ≈ 45% of the average
loss. **The first 46 market-floor trades** (2026-09-26/27): 4 W, 42 L, −0.19 SOL; a flat trade
still cost 4.1% (2.4% venue, 0.2% network, 1.5% rent — the rent is now returned).

**Trend lane on paper**: first 103 trades, variants +0.017 SOL (5 of 19), subtopics −0.223
(11 of 84); 178 trades to 2026-09-30, variants −0.038 SOL. In the 29-minute sample that prompted
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
- **Before the release built on this branch, the heartbeat's `open[]` carried no exit error**
  (§4.3). On older releases a stuck sell is visible only as `counts.exitFailures` climbing; the
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
