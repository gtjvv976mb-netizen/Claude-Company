# Claude Tower

A fifty-floor building. Every floor is one automated Solana research desk. Its core
decision path has fourteen seats including the CEO; the standing Regime and Review seats
bring the permanent team to sixteen. Grok floors may add an alternate PM brain.

Floor 50 is the headquarters. Floors 1–49 are tenancies paid once in $CLAUDECO.

**The hosted desk is research and paper accounting only.** It never receives a private
key, never signs a wallet transaction, and produces an unsigned order slip and a GMGN
link. This repository also contains WALL-ST-E, an isolated polling executor that runs on
the user's own Linux host. It defaults to paper mode; an explicitly armed, supervised
live canary can sign from a dedicated local burner only after the durable journal,
transaction validation, two-private-RPC, freshness, fee, slippage, and risk gates pass.
The legacy webhook executor remains dry-run-only. Browser signing is absent and the old
hosted RPC relay returns `410 Gone` without contacting Solana.

---

## The seats

Deterministic stages are plain code. Judgment stages are Claude. They alternate on purpose:
code narrows the field cheaply, the model only reasons about what survived.

| Stage | Seat | Kind | The one question it answers |
|---|---|---|---|
| 0 | **Scout** | code + model | What deserves attention *today*, and why now? |
| 1 | **Screener** | code | Does this clear the floor at all? *(kills most candidates, costs nothing)* |
| 2 | **Forensics** | model | Can this token be used against a holder, by design? |
| 3 | **Liquidity** | model | Can I get out, at size, at a price I'd accept? |
| 4 | **Flow** | model | Is the demand real, or manufactured? |
| 5 | **Narrative** | model + web | Is there a story, is it true, and am I early? |
| 6 | **Technical** | model | Is this a location worth entering? |
| 7 | **Red Team** | model | *Why does this trade lose money?* |
| 8 | **Risk** | model + code | Choose a tier and thesis stop; code derives size and loss. |
| 9 | **PM** | model | Propose, watch, or pass — on what thesis? |
| 10 | **Execution** | model | The unsigned ticket: route, slicing, stop, targets. |
| 11 | **Compliance** | code | Does this break a house rule? *(veto, not advice)* |
| 12 | **CEO** | model | Do I trust this desk, on this trade, today? |
| 13 | **Scribe** | code | Write it down so the desk can be graded later. |

Two permanent seats sit outside that per-token sequence: **Regime** computes the broader
SOL/BTC weather used by the evidence and portfolio gates, while **Review** grades each
closed call and gives one transferable lesson to the next PM decision.

Codex is available as a separate **Improvement Engineer**, not a trading seat. It reviews
the repository, exact prompt/test provenance, and aggregate house evaluation evidence in
a read-only sandbox during a manually dispatched GitHub Actions run, then emits at most
five structured proposals for human review. It has no route into Risk, PM, Execution,
Compliance, CEO, call publication, wallets, or deploys.

Stages 2–6 run **in parallel and blind to each other**. Five analysts who read each other's
notes produce one opinion wearing five hats; the desk needs five actual opinions.

The **Red Team** is not asked to be balanced — it is asked to destroy the idea. A proposal
survives only if the PM can answer a structured, verified fatal fact with retained evidence.
An answered refutation may reach the CEO at mechanically reduced size; unsupported fatal
prose is retained as a wounded finding, not promoted into a hard veto.

The **CEO** is the only seat shown the desk's own historical record, because its question
isn't "is this a good trade" — the PM already answered that — but "do I trust my desk today".

## What a tenant actually rents

A floor has two complementary paths. House calls are copied to it at no model cost only
when they clear that floor's deterministic mandate. A tenant can also dispatch a metered
full-team workup against a mint; that run has its own journal and, if it clears the same
publication gauntlet, can publish a call only to that floor. Settings, deliveries, runs,
and floor-only calls remain tenant-scoped.

Runs are **metered, not continuous**, and the reason is arithmetic rather than caution.
The paid seats are deliberately tiered: Scout defaults to Haiku; the evidence-shaped
analysts, Risk and Execution to Sonnet; Red Team, PM and CEO to Opus. Effort and retained
evidence make the cost variable, but every workup consumes metered model credit. Forty-nine
unbounded desks cannot be funded by a one-time lease, so the product meters runs instead of
promising unlimited compute.

So: a lease includes `FREE_RUNS_WITH_LEASE` runs, and further runs cost
`RUN_PRICE_CLAUDECO` from the same $CLAUDECO credit balance the lease was paid from. The
tenant points their team at a token; the core fourteen-seat path works it end to end; the
tenant gets a brief and an unsigned ticket they sign themselves, hand to the optional
local executor under its own gates, or decline.

## The building

| Page | Route | What it is |
|---|---|---|
| Website | `/` | The front door: what the desk is, who the sixteen permanent seats are, what a floor costs |
| The tower | `/tower` | All fifty floors in 3D. Click one to select it; the directory tracks it |
| A trading floor | `/floor/:n` | One desk's isometric office, with its agents at work |

The 3D is built to the **Markets & Makers** house style, read out of that codebase rather
than guessed at: a true-isometric orthographic camera (45° yaw, 35.264° elevation — that
is `atan(1/√2)`, not 35 and not 30), AgX tone mapping at exposure 1.12, its exact
three-light rig, and its blocky 21-box citizens bound rigidly to a 15-bone skeleton.

Two house rules that matter, both load-bearing:

- **The room has no front wall and no ceiling, and its side walls are 0.45 units high.**
  That is not laziness — it is how that game solves camera occlusion, architecturally,
  so nothing ever has to be hidden or faded between the camera and a character.
- **Merge, don't instance.** Every static prop is baked into one geometry per finish and
  every avatar is a single skinned mesh. That took the floor from 1,045 draw calls to 99.

## Deploying the website

The site is fully static — every page runs with no backend (the tower and the floors fall
back to a scripted demo shift when there is no desk process to talk to). It deploys to
GitHub Pages automatically:

1. Create the empty GitHub repo and `git push -u origin main`.
2. In the repo: **Settings → Pages → Source: GitHub Actions** (one time).
3. Every push to `main` then builds `dist/` and publishes it. The workflow supplies the
   custom-domain `SITE_URL` and API base so link-preview images and API calls resolve.

Local equivalents:

```bash
npm run build                                 # local preview; executor copy buttons are disabled
INLINE_ASSETS=1 npm run build                 # local artifact preview with images inlined
EXECUTOR_COMMIT="$(git rev-parse HEAD)" npm run build  # pinned release build from a reviewed clean commit
```

CI supplies its exact GitHub commit automatically. A release build rejects malformed
commit pins; an unpinned local preview shows no runnable executor install command.

A custom domain later is Settings → Pages → Custom domain, plus a CNAME at your DNS.

## Deploying the API safely

The hosted API is described by `render.yaml`. Render installs from the lockfile and runs
the isolated root test suite before starting a new revision:

```bash
npm ci
npm test
```

A failed test therefore fails the Render build instead of replacing the live process.
Production SQLite state lives on the persistent disk at `/var/data/claude-co.db`; the
ignored database in a local checkout is not production and must never be used as a test
target. The test runner creates throwaway databases for this reason.

Executor webhook delivery is explicitly disabled in the production blueprint with
`EXECUTOR_WEBHOOKS_ENABLED=0`. The authenticated polling feed remains available to local
paper or explicitly armed canary executors, but the hosted server will not push entry or
exit events to executor URLs. Unsigned transaction preparation is also disabled with
`DESK_PREPARE_TX=0`.
The retired browser RPC endpoint always returns `410 Gone` and never contacts the upstream
Solana RPC.

After deployment, verify `/api/lease/config`, `/api/stats/overview`, `/api/heartbeat`, and
`/api/improvements/status`.
A ready improvement service reports `bundleAuthConfigured: true`, and its `sourceCommit`
must equal the exact 40-character commit SHA deployed by Render before an improvement
review is dispatched. The public status response is deliberately coarse; the review
bundle itself is not public.
A reachable HTTP server does not prove that the model seats can work. `/api/heartbeat`
reports `BLOCKED` when recent Anthropic credit failures have not been followed, at least
five minutes later, by a successful paid seat. Its `providerCredit` object exposes the
failure and success timestamps, failure count, and recovery grace used for that decision.
`RUNNING` is acceptable after a prior credit failure only when `blocked` is false and
`lastSuccessTs >= lastFailureTs + recoveryGraceMs`.

## Running it

```bash
cd ~/Downloads/claude-co && cp .env.example .env
```

Set `ANTHROPIC_API_KEY` in `.env`. Everything else has a working default, though a private
RPC is strongly recommended — the public one rate-limits holder queries, which costs the
Forensics seat real confidence.

An API key without available Anthropic credits is not operational. The HTTP process may
remain reachable in that state, so use `/api/heartbeat` rather than transport health to
decide whether paid research is available.

```bash
npm run doctor
```

```bash
npm run one -- DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 --office
```

```bash
npm run desk -- --office
```

| Command | What it does |
|---|---|
| `npm run doctor` | Config, RPC reachability, journal stats |
| `npm run one -- <mint>` | Full workup on one token |
| `npm run desk` | Scout the feeds, work up the shortlist |
| `npm run watch -- 30` | Same, every 30 minutes, with the floor open |
| `npm run ledger` | Every proposal the desk has made |
| `npm run improvement:bundle` | Print a local, content-addressed aggregate review bundle for diagnostics |
| `npm test` | Run the isolated root regression suite used to gate Render deploys |
| `node src/index.js office` | Serve the site, the tower and the floors |
| `npm run build` | Bundle standalone pages into `dist/` with three.js inlined |
| `npm run check` | Run the full regression suite, then build the static site |

Add `--office` to open the floor at **http://localhost:4949**. Append `?demo=1` to watch a
scripted shift without spending anything.

## Codex Improvement Engineer

The improvement service is deliberately split in two:

1. The live API exposes a coarse public status at `/api/improvements/status`. The full
   `/api/improvements/review-bundle` is protected by a dedicated bearer token and returns
   house-only aggregates, evaluation scorecards, prompt/policy hashes, and the exact test
   manifest. It contains no symbols, mints, workup prose, tenant rows, wallets, sessions,
   executor configuration, provider URLs, or credentials.
2. The manually dispatched **Codex improvement review** GitHub Actions workflow is the
   only supported worker environment. It verifies the bundle's `sourceCommit` against
   the exact checked-out `GITHUB_SHA`, verifies both manifests and the content digest,
   runs Codex with a read-only sandbox, approvals and agent networking disabled, and
   writes JSON and Markdown proposals. It never runs inside Render's trading process and
   never receives the production database or trading secrets.

To activate it, configure a high-entropy `CODEX_REVIEW_TOKEN` in Render and set the
GitHub Actions secret of the same name to the **exact same value**. Also configure these
repository Actions secrets:

- `OPENAI_API_KEY` — project-scoped credential used only by the isolated worker.
- `CODEX_REVIEW_TOKEN` — read-only bearer credential matching Render.
- `CODEX_ARTIFACT_KEY` — a separate random passphrase of at least 32 characters.

Redeploy Render, request `/api/improvements/status`, and confirm
`bundleAuthConfigured` is `true` and `sourceCommit` is the exact commit SHA the workflow
will check out. A missing Render token leaves the full endpoint unavailable; a missing or
mismatched GitHub token cannot fetch it. Dispatch the workflow only after Render is on
that exact commit, because the worker rejects stale or differently built bundles.

The workflow uploads only `codex-improvement-review.tar.gz.gpg`, encrypted with GPG and
retained for seven days. Download it and decrypt it without putting the passphrase in
shell history:

```bash
read -rs CODEX_ARTIFACT_KEY
printf '%s' "$CODEX_ARTIFACT_KEY" | gpg --batch --yes --pinentry-mode loopback \
  --passphrase-fd 0 --output codex-improvement-review.tar.gz \
  --decrypt codex-improvement-review.tar.gz.gpg
unset CODEX_ARTIFACT_KEY
mkdir codex-improvement-review
tar -xzf codex-improvement-review.tar.gz -C codex-improvement-review
```

Keep the artifact key outside the repository and rotate it periodically and immediately
after suspected exposure. If old artifacts still matter, retain their prior key securely
until their seven-day retention window expires. An artifact is advice, never a patch or
approval: the service cannot auto-apply, commit, push, merge, deploy, or trade. Every
proposal still requires a human-owned branch, full tests, review, and explicit merge. The
worker also rejects policy-change proposals until there are at least 100 distinct,
actually published assets with comparable 24-hour signals from the current decision
manifest and at least 80% resolved-mark coverage.

## The trading floor

A top-down view of the firm. Each figure is one agent, and they move because a pipeline
stage actually started or finished — not on a timer. Analysts print their notes and carry
them to the Red Team; the Red Team walks its verdict to Risk; Risk walks size to the PM;
the PM stops at the threshold and slides proposals **under the CEO's door**. Rejects go in
the shredder. Everything ends up in the journal.

The CEO's office is the one room no other agent enters.

## How an order reaches you

GMGN sits behind Cloudflare bot protection, so this desk **cannot** reach it server-side and
does not try. Instead a published call becomes:

1. an order slip in `reports/` — ruling, size, stop, conditions, and what the desk got wrong;
2. a **GMGN deep link** you open in your own browser, where your wallet lives;
3. optionally, a real **unsigned** Jupiter transaction, if you set `DESK_WALLET_PUBKEY`.

`DESK_WALLET_PUBKEY` is a **public** key. The hosted desk never reads, requests, stores, or
accepts a private key or seed phrase. WALL-ST-E loads a dedicated burner only on the
user's machine; paper mode is the default, and the sole live-capable path is the local
polling canary documented in `executor/README.md`. The legacy webhook adapter remains
dry-run-only.

## What it costs

Model defaults are cost-aware: Haiku scouts; Sonnet handles structured evidence work; Opus
is reserved for Red Team, PM and CEO judgment. The running total is printed each cycle.
The screener is the main cost control: it is pure code and rejects most candidates before
a model call. To spend less, lower `DESK_MAX_CANDIDATES` or override an individual
`DESK_MODEL_*` setting; deterministic seats have no model cost.

## Known limits

- **`fdv_propped` mis-fires on CEX-listed majors.** The ratio compares FDV to *DEX*
  liquidity, so a token whose real depth is on centralised venues looks thin. It is the
  right test for the DEX-native tokens this desk actually scouts; BONK trips it.
- **The Technical seat has a genuinely thin dataset** — four price-change windows, no candle
  history. It is instructed to keep its confidence low and not invent chart levels.
- **Holder concentration is often unavailable** on the public RPC, and the desk reports that
  rather than estimating it.
- **Nothing here has an edge until you have graded it.** Read the first weeks of the journal
  as a backtest you are watching forward.
- **The live executor is an experimental local canary, not evidence of an edge.** It is
  Metis exact-in/classic-SPL-only, hard-capped, and requires operator-owned infrastructure;
  browser and webhook signing remain disabled. Dry runs, simulations, and successful fills
  do not establish positive expectancy.

## The charter

`DESK.md` is the firm's constitution, and it is injected verbatim into every agent's system
prompt — so the rules bind the agents in-band, not just the reader.
