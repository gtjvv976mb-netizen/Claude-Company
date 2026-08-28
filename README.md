# Claude Tower

A fifty-floor building. Every floor is one automated Solana research desk: fourteen
purpose-built agents working a single trade from end to end, plus a CEO seat behind a
brass door that only the floor's owner can open.

Floor 50 is the headquarters. Floors 1–49 are tenancies at 50 USDC, one-time.

**It researches and prepares orders. It does not execute them.** There is no signing code
and no key handling anywhere in this repository, and none should ever be added. The desk's
final artifact is an unsigned order slip and a GMGN link. You place the trade.

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
| 8 | **Risk** | model | How much, and where is it mechanically wrong? |
| 9 | **PM** | model | Propose, watch, or pass — on what thesis? |
| 10 | **Execution** | model | The unsigned ticket: route, slicing, stop, targets. |
| 11 | **Compliance** | code | Does this break a house rule? *(veto, not advice)* |
| 12 | **CEO** | model | Do I trust this desk, on this trade, today? |
| 13 | **Scribe** | code | Write it down so the desk can be graded later. |

Stages 2–6 run **in parallel and blind to each other**. Five analysts who read each other's
notes produce one opinion wearing five hats; the desk needs five actual opinions.

The **Red Team** is not asked to be balanced — it is asked to destroy the idea. A proposal
survives only if the PM can say *how* the attack was answered, and that answer is a required
field. "Refuted" can never become a proposal.

The **CEO** is the only seat shown the desk's own historical record, because its question
isn't "is this a good trade" — the PM already answered that — but "do I trust my desk today".

## The building

| Page | Route | What it is |
|---|---|---|
| Website | `/` | The front door: what the desk is, who the fourteen are, what a floor costs |
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
3. Every push to `main` then builds `dist/` and publishes it. The workflow sets `SITE_URL`
   so link-preview images resolve absolutely.

Local equivalents:

```bash
node scripts/build-viewer.mjs                 # plain static build into dist/
INLINE_ASSETS=1 node scripts/build-viewer.mjs # artifact build: images inlined as data URIs
```

A custom domain later is Settings → Pages → Custom domain, plus a CNAME at your DNS.

## Running it

```bash
cd ~/Downloads/claude-co && cp .env.example .env
```

Set `ANTHROPIC_API_KEY` in `.env`. Everything else has a working default, though a private
RPC is strongly recommended — the public one rate-limits holder queries, which costs the
Forensics seat real confidence.

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
| `node src/index.js office` | Serve the site, the tower and the floors |
| `node scripts/build-viewer.mjs` | Bundle standalone pages into `dist/` with three.js inlined |

Add `--office` to open the floor at **http://localhost:4949**. Append `?demo=1` to watch a
scripted shift without spending anything.

## The trading floor

A top-down view of the firm. Each figure is one agent, and they move because a pipeline
stage actually started or finished — not on a timer. Analysts print their notes and carry
them to the Red Team; the Red Team walks its verdict to Risk; Risk walks size to the PM;
the PM stops at the threshold and slides proposals **under the CEO's door**. Rejects go in
the shredder. Everything ends up in the journal.

The CEO's office is the one room no other agent enters.

## How an order reaches you

GMGN sits behind Cloudflare bot protection, so this desk **cannot** reach it server-side and
does not try. Instead an approved order becomes:

1. an order slip in `reports/` — ruling, size, stop, conditions, and what the desk got wrong;
2. a **GMGN deep link** you open in your own browser, where your wallet lives;
3. optionally, a real **unsigned** Jupiter transaction, if you set `DESK_WALLET_PUBKEY`.

`DESK_WALLET_PUBKEY` is a **public** key. There is no code path in this project that reads,
requests, stores or accepts a private key or seed phrase.

## What it costs

Every LLM seat runs on `claude-opus-5` by default and the running total is printed each
cycle. The screener is the main cost control: it is pure code and rejects most candidates
before a single token is spent. To spend less, lower `DESK_MAX_CANDIDATES`, or set a cheaper
model per seat (`DESK_MODEL_TECHNICAL=claude-sonnet-5`) — the mechanical seats lose least.

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

## The charter

`DESK.md` is the firm's constitution, and it is injected verbatim into every agent's system
prompt — so the rules bind the agents in-band, not just the reader.
