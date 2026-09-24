# HAWK-AI for Phantom — the launch sniper in your browser

A Chrome extension that runs HAWK-AI's lane against **your own Phantom**. It watches
pump.fun's program logs, runs every launch through the **same entry contract WALL-ST-E
runs** (`executor/snipe-entry.mjs`, imported into the bundle, never copied), keeps a
would-have position and a shadow book for every launch that clears, and — once you have
armed it with the sentence it prints for your wallet — asks Phantom to sign each buy and
each sell. **One approval window per trade. It never holds a key.**

It is not in a store. You build it from this repository and load it unpacked.

## What HAWK-AI's trades taught this lane

The executor's live record, read back off mainnet in full on 2026-09-17 (see
`executor/README.md`, "What 58 real trades changed" and the sections after it):

| | |
|---|---|
| first 58 round trips | **10 up, 48 down, −1.58 SOL**; average winner +75%, average loser −22% |
| six more, under the socials filter and the stall exit | 1 up, 5 down, −0.07 SOL |
| positions that ran to the old ten-minute clock | **18, none won** |
| where the net loss sat | every SOL of it in tickets of 0.35 SOL and up |
| entries under 3 seconds late | 9, **0 won**, mean −18.5% |
| entries 10 seconds and later | 10, 40% won, mean +34% |
| coins that reached 1.5× after the fill | 28 of 64; the bot took it on 5 |
| any signal at entry that ordered the outcome | none (every Spearman ρ under 0.13) |
| the best modelled exit ladder over the 64 | still −0.12 SOL |

Four things in this lane follow from that record, and this is where they are said:

1. **It waits.** A cleared launch is not bought at first notice. It opens a would-have
   position, and only once that position is `entryWaitMs` old (default 10 s) **and still
   marks at or above `entryFollowThroughX`** (default 1.0×) of its own would-have fill
   does the lane re-read the curve, run the contract again with the exact `buy_v2` it
   will sign, and ask Phantom. The mechanism the record suggests is bundles: a launch
   reachable inside three seconds is one already bundled, and arriving right behind the
   bundle makes you its exit liquidity. The shadow book's positive class — "a launch
   nobody followed" — is precisely a curve whose mark fell below the would-have fill.
2. **It takes at 1.5×**, not the policy's 2×. 44% of the coins reached 1.5×; 25% reached
   2×; the 1.5× take was worth about +0.24 SOL over the 64 at a 0.1 SOL ticket.
3. **The stall exit is on** (90 s at ≤ 1.0×) and the time stop is three minutes — and see
   the bug note below, because on the executor it was not.
4. **The shadow book is the executor's own** (`executor/snipe-shadow.mjs`, imported).
   Export it from the popup and grade it with the command the repository ships:
   `node executor/grade-entry-gates.mjs --file hawk-shadow-<date>.jsonl`. The popup also
   shows the scorecard live. The two rulers, `creator_profile` and `launch_share`, measure
   and never kill until the scorecard says they are promotable; the thresholds are in
   Options, blank by default, exactly as on the executor.

**None of this is evidence of an edge.** The record loses, every modelled variant of it
loses, and nothing measured at entry orders the outcome. What the record supports is a
rule that keeps this lane out of the one bucket that never won, and a book that will
say — over thousands of unselected rows — whether anything separates a good launch from
a bad one. The arming screen puts these numbers beside the switch. Observe first.

### The bug the browser lane found in the executor

`effectiveLaneConfig()` in `executor/snipe-lane.mjs` folds the policy dials into what the
determiner reads. `SNIPE_LANE_DEFAULTS.stallMs` is `null` — "the policy's own default,
90000" — and `Number(null)` is `0`. For the four dials bounded at `> 0` that zero failed
the bound and nothing was folded. `stallMs` is bounded at `>= 0`, because `0` is how an
operator turns the stall off, so **every lane that had not typed `SNIPE_STALL_MS` ran
with `stallMs: 0` — no stall exit — while the README said 90000.** The record carries
the fingerprint: the four post-change losers sat in the 120–300 s band, which is where
the 180 s time stop puts a position the 90 s stall never saw. Fixed in this change;
`executor/test-snipe-stall-default.mjs` pins it and prints what the determiner sees.

## How it is built

```
extension/
  manifest.json          MV3; the permissions are pinned by test-hawk-manifest.mjs
  build.mjs              esbuild; one plugin swaps node:crypto and jupiter.mjs for browser shims
  src/background.mjs     the service worker: hosts the engine, owns the bridge, the badge, notifications
  src/content.mjs        on the console page only: injects injected.js, relays with a nonce
  src/injected.mjs       in the page's world: the only code that touches window.phantom.solana
  src/lib/engine.mjs     the lane — dependency-injected, runs in Node for its tests
  src/lib/config.mjs     the dials, the arming checklist, RECORD
  src/lib/rpc.mjs        a small JSON-RPC client and the logsSubscribe feed with its watchdog
  src/lib/tx.mjs         transaction assembly (mirrors snipe-execute.mjs) and the fill reader
  src/popup/, src/options/
```

Phantom injects its provider into web pages only, never into an extension's own pages.
So signing happens in a tab showing **the console page** — `/hawk` on the site
(`viewer/hawk.html`), or `http://localhost:4949/hawk` from the office server. The content
script there opens a port to the worker; the injected script there calls
`provider.signTransaction`. A sign request goes worker → content → injected → Phantom and
back the same way, with an id and a nonce. **No console tab, no bridge, no signing**, and
the checklist says so.

What a buy is, end to end: the feed's `logsSubscribe` notice → `noticesFromLogs` (the
venue's own parser) → one `getMultipleAccounts` (curve, Global, mint) → `snipeContract`
in observe mode → a would-have position and a shadow row → the wait → a fresh read →
`planSnipeCeiling` → `buyIx` → `snipeContract` in execute mode, which decodes the bytes
back and matches them to the plan → a v0 transaction (compute budget, idempotent ATA
create, `buy_v2`) → **simulated on your RPC with a spend ceiling and a delivery floor** →
one Phantom window → the signed bytes are checked to be the same message → sent with
preflight skipped → confirmed → the fill read from the transaction's own balances →
booked, charged to the rolling day. A sell is the same path with `sell_v2` and a floor
set from the curve's own quote less `sellToleranceFrac`.

## Install

```bash
npm ci --prefix executor --ignore-scripts     # the executor's web3.js pin, shared by the bundle
npm ci --prefix extension                     # esbuild
npm run build --prefix extension              # → extension/dist
```

1. `chrome://extensions` → **Developer mode** → **Load unpacked** → `extension/dist`.
2. Open the extension's **Options** and paste an RPC URL (Helius, Triton, QuickNode). The
   public mainnet RPC refuses browsers. A second RPC is optional; with one set, both must
   agree on the curve before a mark is trusted.
3. Open the console page — the popup's **Console** button — and press **Connect Phantom**.
4. In the popup choose **Observe**. Watch the shadow book fill. Export it, grade it.
5. To arm: choose **Execute**, read the checklist, type the sentence the lane prints for
   the connected wallet into the box, press **Arm**. The lane compares it byte for byte,
   as WALL-ST-E does with `SNIPE_LIVE_ACK`. A ticket above the 0.005 SOL canary must also
   have a stop you chose.

`npm run watch --prefix extension` rebuilds on save; press the reload arrow on the
extension card afterwards.

## What it refuses, and what you must know

- **A stop that needs a click is a weaker stop than a key's.** Every exit — take, stop,
  creator exit, stall, time stop, hard stop — is one Phantom window. The lane asks again
  every `sellReaskMs` (8 s) while the determiner still says sell, fires a notification,
  and puts SELL on the badge. It cannot press Approve for you.
- **Keep the console tab open.** Close it and the lane loses its signer; open positions
  are still yours, and still priced, but nothing can be sold until it is back.
- **A buy window that sits past `approvalTimeoutMs` (25 s) is abandoned.** A launch that
  old is not the launch that cleared the gates. A declined buy is never re-asked.
- **One live position at a time** by default (`maxOpenPositions`). One window at a time
  is the whole point.
- **A curve that has graduated to a pool cannot be sold by this lane** — it sells on the
  curve only, as the executor does. The row says SELL BY HAND; sell it on pump.fun or
  Jupiter, then press **Forget** on the row. The realized figure then reads "not read",
  never zero.
- **The manifest is the charter.** Permissions are `storage`, `alarms`, `notifications`;
  the content script matches the four console URLs only; `injected.js` is the only
  web-accessible resource; no `<all_urls>`, no `tabs`, no `scripting`. Widening any of it
  fails `test-hawk-manifest.mjs`.
- **It never holds a key.** `test-hawk-no-key.mjs` scans every source file for a
  `Keypair`, a `secretKey`, a seed, a mnemonic, `signAllTransactions`, `signMessage` and
  Phantom's sign-and-send, on every suite. The engine also refuses to send any signed
  transaction whose message is not the one it asked Phantom to sign.
- **Two RPCs are optional here; on the executor they are mandatory.** A single provider
  is a single witness. The row's `endpointVerdict` says `single` when that is the case.
- **The service worker can be put to sleep by Chrome.** The websocket feed and the
  console port keep it awake in practice (Chrome 116+); an alarm every 30 s wakes it if
  not; state is written to `chrome.storage.local` so a restart resumes with the book, the
  spend ledger and the shadow rows intact. A live position across a worker restart is
  re-priced on the next tick; a sell that was pending is asked again.
- **The record is beside the switch on purpose.** Nothing here is advice, and nothing
  here has an edge until you have graded its book.

## Tests

The four suites under `extension/` run with the root `npm test` (they are discovered by
`scripts/test-all.mjs` like the executor's):

| file | proves |
|---|---|
| `test-hawk-engine.mjs` | the lane end to end against a scripted chain that executes the venue's own `buy_v2`/`sell_v2` and a scripted Phantom: notice → shadow row → the wait → re-read → sign → fill from balances → take at 1.5× → declined sell re-asked → approved sell closes with the chain's SOL; a launch nobody followed is never bought; a declined or unanswered buy; a tampered signature refused; the day cap; the hard stop; the JSONL export read back by `shadow-sink.mjs` and scored by `snipeScorecard` |
| `test-hawk-manifest.mjs` | the permissions, matches and resources above |
| `test-hawk-no-key.mjs` | no key, no key derivation, no signer but the bridge, in source and in the bundle |
| `test-hawk-bundle.mjs` | the shims agree with what they replace; the build succeeds; every entry parses with no `node:` specifier; the bundled engine refuses a stale notice at the same gate the executor's contract does |

`executor/test-snipe-stall-default.mjs` pins the executor fix described above.
