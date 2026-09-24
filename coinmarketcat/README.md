# COINMARKETCAT

*The sniper cat. It hovers ten seconds over every launch and buys only what others followed.*

CoinMarketCat — the sniper cat, the first trading agent of Cat Intelligence Agency — is
the Claude Company launch sniper's lane (HAWK-AI's), run in your own browser. You set the
limits: the take-profit, the SOL per trade, the daily budget it will not exceed, the stop,
and which stock-paired tokens to focus on. You also choose who signs:

- **Phantom, one approval per trade** (the default). The extension holds no key. Every buy
  and every sell is one Phantom window on the console tab.
- **Autopilot.** The extension generates one wallet of its own, keeps its key encrypted
  under your passphrase, and — while you have it unlocked — signs the lane's buys and
  sells without asking. You fund it from Phantom with one approval and sweep it back when
  you are done. This is the one mode in which the extension holds a key; see
  [Who signs](#who-signs-phantom-per-trade-or-autopilot) for exactly what that means.

When you install it, a setup page opens and walks you through your own limits before
anything can spend.

It is a Chrome extension you build from this repository and load unpacked. It is not in
a store.

## What it does

- **Watches pump.fun's own program logs** and runs every launch through the same entry
  contract WALL-ST-E runs. The contract, the exit determiner, the curve arithmetic, the
  proved `buy_v2`/`sell_v2` encoders and the shadow book are the executor's own modules,
  copied verbatim from a named commit of
  [Claude-Company](https://github.com/gtjvv976mb-netizen/Claude-Company) into
  `vendor/executor/` and hashed in `PROVENANCE.json`. What this bot refuses is decided
  upstream and synced here, never edited here.
- **Hovers, then buys only what others followed.** Every launch that clears opens a
  would-have position. In an armed lane, only once that position is ten seconds old
  **and still marks at or above its own would-have fill** does the lane re-read the
  curve, rebuild and simulate the exact instruction it will sign, and ask Phantom (or, on
  autopilot, have the autopilot wallet sign it).
- **Leaves in full** at the 1.5× take, the stop, the creator's exit, the 90-second stall
  or the three-minute clock — each one more Phantom window, or on autopilot, none.
- **Keeps the executor's shadow book**, exported as the JSONL
  `node vendor/executor/grade-entry-gates.mjs --file <export>` reads, with the scorecard
  for the two entry rulers live in the popup.
- **Puts its own losing record beside the arming switch.** The lane starts **Off**; you choose Observe before you ever choose Execute.
- **Trades on its own, if you choose autopilot** — from a wallet you funded, inside the
  same caps, with the balance as one more cap the chain enforces.
- **Can pay in a tokenised stock, if you list one.** pump.fun "Custom Pairs" let a launch be
  priced in a token instead of SOL; the ones this lane is built and tested for are xStocks
  (GLDx, TSLAx, SPYx), paid from the stock already in your wallet. With nothing listed — the
  default — every such launch is refused, as before. See [Launches quoted in a stock](#launches-quoted-in-a-stock-pumpfun-custom-pairs).
- **Can watch new pools paired with a stock anywhere on Solana, if you turn it on.** A second
  venue, **off by default**, polls public new-pool feeds for pools on any exchange that pair
  a token with an xStock you watch, and trades them through Jupiter, paid in that stock,
  inside that stock's limits. It follows the lane: Observe only watches. See
  [New pools paired with a stock, through Jupiter](#new-pools-paired-with-a-stock-through-jupiter-off-by-default).

## What HAWK-AI's trades taught it

The executor's live record, read back off mainnet in full on 2026-09-17 (the tables are
in Claude-Company's `executor/README.md`):

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

The wait, the follow-through rule and the 1.5× take follow from that record. **None of it
is evidence of an edge.** The record loses, every modelled variant of it loses, and
nothing measured at entry orders the outcome. What the record supports is a rule that
keeps this lane out of the one bucket that never won, and a book that will say — over
thousands of unselected rows — whether anything separates a good launch from a bad one.

Wiring this lane also found a bug in the executor: an unset `SNIPE_STALL_MS` read as
`0`, which is *off*, so the 90-second stall exit was never running by default. The fix
and its regression (`vendor/executor/test-snipe-stall-default.mjs`) are in the vendored
commit.

## Launches quoted in a stock (pump.fun Custom Pairs)

In **Options → Stock quotes** you may list up to eight stock mints, each with its own
numbers **in that stock's units**: a ticket per launch, a canary (the first buy), and a
rolling 24-hour cap. The shortcuts for GLDx, TSLAx and SPYx carry the addresses and symbols
read from each mint account on mainnet (the vendored fixture
`vendor/executor/fixtures/pumpfun-xstock-quote.json`). What the lane then does:

- **It reads the stock's mint on the same call as the curve.** A listed stock's mint account
  rides on the one `getMultipleAccounts` every launch already costs, and the executor's
  `describeMint` reads its token program, decimals and pause switch. It is *described*,
  never *audited*: the base-mint kill set (`auditMintAccount`) rightly refuses every xStock,
  because each carries a permanent delegate, a live freeze authority and a pause switch
  held by its issuer. The executor's entry contract gets those facts as `quote` and judges
  the ticket, the minimum and the day cap in the stock's raw units.
- **It refuses** a stock that is not listed, a listed symbol that is not the mint's own, a
  paused stock (at first notice, at the moment of asking, and it will not ask Phantom to
  sell while one is paused), a stock whose transfer hook points at a live program, a wallet
  holding less of the stock than the buy's ceiling, and a buy whose SOL fee and rent would
  break the SOL day cap. Each refusal says which.
- **It pays through the right accounts.** The quote's token program is the stock mint's
  owner (Token-2022 for an xStock), never assumed; the wallet's stock account is its
  179-byte Token-2022 associated account, created idempotently before the buy and the sell.
  The simulation must show the stock account paying at most the ceiling and SOL moving by
  the fee and rent caps only; the fill is read from the transaction's token balances in the
  stock's decimals, and a lamport that is not fee or rent is a refusal, not a fee.
- **It books in the stock.** A stock position's size, P&L and day ledger are in the stock;
  its network fee and rent are SOL, reported beside it and charged to the SOL day. The two
  are never added together: there is no SOL price for an xStock in this lane. The shadow
  book grades stock-quoted launches on their own card per stock, never pooled with SOL.
- **The first live buy in each stock is a canary.** No buy on a stock-quoted pump.fun curve
  had been observed on chain when this was built — only one sell — so the buy's account
  order rests on the venue's IDL and the SOL buys it was proven against. The first live buy
  in each listed stock is sized at its canary (`minPerTrade`); the full ticket is used only
  after one buy in that stock has landed and its fill was read back off the chain. A buy
  that lands but cannot be read back or booked **blocks** that stock, says so in the log,
  the notification and the popup, and stays blocked until you check the signature, sell
  by hand, and press *clear the block*. The popup shows each stock's state (canary, proven,
  blocked), and the arm sentence names each stock's canary and mint.

**What is not measured.** HAWK-AI's record is SOL-quoted launches only. Nothing is known
about stock-quoted launches: not a win rate, not whether they follow through, not the fee
on a buy (one sell was read: 125 bps of the quote), not the compute a two-account-create
buy uses. A stock-quoted row's round-trip friction cannot include its SOL fees, so the stop
you choose is its only stop, and the lane will not arm with a stock listed until you have
chosen one. SPYx carries a display multiplier: Phantom shows it scaled, this lane shows the
raw count over 10^8. A coin that graduates to a pool must be sold by hand, as with SOL.

## New pools paired with a stock, through Jupiter (off by default)

The pump.fun lane hears launches from the pump.fun program's own logs. Tokens are also
launched straight into pools on Raydium, Meteora, Orca and launchpads, paired with an xStock
instead of SOL, and there is no single program to listen to for those. This venue reads what
public indexers publish about new pools and trades the ones that pass its gates through
Jupiter. Turn it on in the popup's **Venues** card (or Options). With the lane on **Observe**
it only watches; it buys only when the lane is armed, and the arm sentence names it.

**Where it looks** (Options → *Feeds*; each was read live on 2026-09-24 and its captured
answer is in `fixtures/xstock-pools/`):

| feed | what it is | what to know |
|---|---|---|
| GeckoTerminal `new_pools` | the 20 newest Solana pools of any pair | cached 30–60 s; the free tier answered 429 to the first request of the session |
| DexScreener `token-pairs` | up to 30 pools of one stock, either side | ordered by liquidity, so a pool with none yet can be missed; 300 requests a minute |
| Jupiter `gems` (opt-in) | the 30 newest launchpad pools, with their quote mint | **undocumented**; it may change or stop without notice |

It watches the stocks you listed in Options → Stock quotes. With none listed it watches a
built-in list of fifteen xStocks (addresses from the official product page, read
2026-09-24) and can only observe them: a stock with no ticket is refused at
`stock_not_listed`. Every pool found is recorded in the popup with the feed that found it,
how old it was when first seen, and what became of it. A feed that answers 429 or fails rests
a minute (a `retry-after: 0` is not trusted), and longer each time it keeps failing.

**What it pays with.** The pool's own stock, from the stock already in your wallet, at that
stock's listed ticket, canary and 24-hour cap — the same numbers and the same day ledger the
pump.fun stock lane uses. Jupiter is asked for **direct routes only**, so the swap goes from
the stock to the token on a pool that pairs them, and nothing else touches the wallet. The
network fee and the token account's rent are SOL, charged to the SOL day; on autopilot the
wallet's SOL balance must cover them.

**What it refuses, and in what order** (the first gate that fails names the refusal):

- *in-process:* the lane or venue off, no RPC, HARD STOP, paused entries; `no_new_token` (the
  other side is SOL, USDC, USDT or another stock: a market in the stock, not a launch);
  `left_to_pumpfun_lane` (a pump.fun bonding curve: that lane hears it from the program's logs
  with its own gates and canary); `notice_stale` (first seen more than 5 minutes after it was
  created, or undated); already held or already judged; `stock_not_listed`;
  `stock_canary_blocked`.
- *one account read:* `mint_refused` — the executor's `auditMintAccount` on the **new token**
  (plus a live mint or freeze authority), never on the stock, whose permanent delegate and
  pause switch the audit refuses; the live GAYMF token in the fixture is refused here for
  its TransferFee extension. `stock_unpayable` — the stock described (paused, a live
  transfer hook, a symbol that is not the listed one) and its ticket checked by the
  executor's `quoteTicketFor`. `daily_capacity`, `daily_capacity_sol`, and the fee and rent
  caps through the executor's `assertNetworkFeeBudget`.
- *Jupiter:* `no_route` (Jupiter cannot price it — the brand-new pump.fun curve quoted in GLDx
  answered `TOKEN_NOT_TRADABLE`), `quote_mismatch`, `route_not_direct`, `impact_over_cap`,
  `no_exit_route` (it cannot price the way back), `round_trip_over_cap`.

A pool that clears opens a would-have position. In an armed lane the entry rule is the
pump.fun lane's: after 10 s it must still mark at or above its would-have fill, the mark
being Jupiter's quote to sell it straight back. Exits are the same determiner (1.5× take,
stop, 90 s stall, 180 s time stop, the hold clock), sold back through Jupiter.

**The check before anything is signed.** Jupiter builds the transaction here, so each one is
decoded and bound before Phantom (or the autopilot wallet) sees it. The check is a port of
the executor's own Jupiter validator: the wallet must be the fee payer and the only signer;
every lookup table is read from **your** RPC, never taken from Jupiter; the only programs
allowed are the compute budget, idempotent creates of the wallet's own account for the two
mints, and one Jupiter `route_v2` whose data must spend **exactly the ticket**, at the
quote's output and slippage (inside the cap), with no fee of its own, from the wallet's own
stock account into its own token account; the priority fee must be inside the lane's. Then
no other token account of the wallet may be writable; then the engine's own simulation must
show the stock paid is exactly the ticket, the tokens delivered at or above the floor, and
SOL moving by the fee and rent only; then neither account may have gained a delegate or a
close authority. A transaction that spends from another account, changes the amount, sends
the output elsewhere, adds a transfer or a signer, or hides an account behind a lookup
table is refused **before signing**, by name (`transaction_refused`, `simulation_refused`).
The fill is then read from the transaction's own balances, as for pump.fun.

**The canary, for this venue.** The first live buy here in each stock is that stock's
canary size (`minPerTrade`); the full ticket only after one Jupiter fill in it has been read
back off the chain. A buy that was sent and cannot be read back or booked blocks that stock
in this venue until you check the signature and press *clear the block* in the Venues card.

**What is not measured.** Nothing about these pools has been measured by this lane: no win
rate, no follow-through, no fill. HAWK-AI's record is pump.fun launches paid in SOL. The
feeds see a pool a minute or more after it is created, so the 10 s wait runs from first
sight, not from creation. Keyless Jupiter answers about one request every two seconds,
shared by every quote and mark, so marks are seconds apart and would-have rows beyond two
are recorded, not marked. On the one pool read while this was built (GAYMF / GLDx, Raydium
CPMM, 0.01 GLDx) a round trip through Jupiter returned 899,767 of 1,000,000 raw GLDx — about
10% before network fees, which the follow-through rule then has to clear. Jupiter's own
program and the pool's program still run inside the swap: the check above bounds what the
wallet can lose to them in the simulation, not what those programs are. Jupiter calls
`/swap/v1` "no longer actively maintained" and names a successor; no sunset date is
published.

## Who signs: Phantom per trade, or autopilot

**Phantom per trade** is the default. Phantom has no auto-approve, and this mode does not
route around it: a buy the lane clears becomes one Phantom window on the console tab; a
sell the exit rules order becomes one Phantom window. The extension never sees a key.
Close the console tab and the lane cannot sign; a stop that needs a click is a weaker
stop than a key's.

**Autopilot** trades without asking. In the popup's *Who signs* card:

1. **Create** the autopilot wallet: a passphrase of at least 12 characters, typed twice.
   The extension generates a keypair and stores its 64-byte secret as AES-GCM-256
   ciphertext under a key PBKDF2-SHA256 derives from your passphrase (600,000 iterations,
   a fresh salt and nonce every write), in `chrome.storage.local`. The passphrase is never
   stored. There is no reset: write it down somewhere that is not this browser.
2. **Fund from Phantom**: an amount you type (default: your daily budget), or a listed
   stock. The extension builds the transfer, simulates it, and asks Phantom **once**, on
   the console tab.
3. **Unlock** for a while (8 hours by default; 5 minutes to 24 hours, set in Options). The
   decrypted key then sits in `chrome.storage.session` — memory only, readable by the
   extension's own pages and worker, gone when the browser closes — until the unlock runs
   out. **Lock** removes it at once.
4. **Arm**: the sentence you type names the autopilot wallet's address and ends *"signed
   without asking me, by the autopilot key this browser holds"*. A sentence typed for
   Phantom cannot arm autopilot. The checklist adds three items: the wallet exists, it is
   unlocked, and it holds enough for one buy (the ticket, the buy's fee and rent, one
   sell's fee, and the 0.00089088 SOL rent floor).
5. **Sweep back**: every token it holds (by `TransferChecked`, each emptied account closed
   for its rent), every empty token account closed, then all SOL above the rent floor — to
   your Phantom wallet, signed by the autopilot wallet. Refused while it holds a live
   position (the position would have no SOL left to sell with).
6. **Export** is for recovery: with the passphrase, the key is shown once in the base58
   form Phantom imports. After exporting, treat the wallet as exposed: sweep it and
   **Replace** it (the popup does this only for a swept wallet holding no position, and
   only with its current passphrase).

What is true on autopilot, plainly:

- **A key in a browser is a bigger attack surface than Phantom.** While the wallet is
  unlocked, anything that can read the extension's session storage — malware on the
  machine, a debugger attached to the worker, a hostile extension — can read the key and
  spend what the wallet holds. A keylogger has the passphrase.
- **Your exposure is what you fund it with.** The budget is enforced twice: by the day cap,
  as always, and by the balance — a buy the wallet cannot cover is refused by name before
  anything is signed (`autopilot_balance_short`), and were that check wrong, the chain
  would refuse the spend.
- **Locking clears the unlocked key; a locked wallet signs nothing** — including sells. An
  unlock that runs out locks itself and says so; a position the locked wallet holds waits,
  with a notification, until you unlock it.
- **A sell is always signed by the wallet that holds the position**, whatever the signer
  setting says now, so switching modes never strands one. A curve that graduates must be
  sold by hand: Forget the row, Sweep back, and sell it in Phantom.
- **The console tab is not needed to trade on autopilot** (only to fund). The worker is
  kept awake by the feed's socket and the half-minute keepalive alarm.
- **Unmeasured:** no autopilot trade, fund or sweep has been made on mainnet. The path is
  proven against the scripted chains in the tests below and nowhere else. Autopilot
  changes who signs, not what is bought: the record below still loses.

`docs/session-wallet.md` has the threat model.

## Install

```bash
git clone https://github.com/gtjvv976mb-netizen/coinmarketcat
cd coinmarketcat && npm ci && npm run build      # → dist/
```

1. `chrome://extensions` → **Developer mode** → **Load unpacked** → `coinmarketcat/dist`.
   A setup page opens: connect, pick a style, set your limits, choose stocks and who
   signs, and save — which puts the lane in **Observe**. Everything it sets stays editable
   in Options, and the popup's *Setup* link opens it again. The styles: **Balanced** is
   the lane's own defaults (the record's 1.5× take, 90 s stall and 180 s time stop at the
   executor's 0.005 SOL canary, 0.01 SOL a day); **Cautious** is no looser on any dial and
   tighter on three (one canary a day, 60 s stall, 120 s time stop — a choice, not a
   measured improvement); **Bold** is labelled *looser than the record supports* (0.05 SOL
   a ticket, 0.25 SOL a day, 2× take, 120 s stall, 300 s time stop, a proposed 0.5× stop).
   Every style keeps the 10 s wait and the ≥ 1.0× follow-through. The stock checklist
   offers GLDx, TSLAx and SPYx (read from the vendored fixture) and AAPLx and NVDAx (read
   over RPC on 2026-09-24, not in the fixture); a ticked stock is written into the same
   stock list Options edits, in that stock's own units.
2. Open the extension's **Options** and paste an RPC URL (the setup page asks for it too) (Helius, Triton, QuickNode). The
   public mainnet RPC refuses browsers. A second RPC is optional; with one set, a curve
   the two disagree on is not trusted, and a read one of them missed or failed is used
   alone (the shadow row's `endpointVerdict` says `single` or `one_missing`).
3. Open the console page — the popup's **Console** button opens
   `https://gtjvv976mb-netizen.github.io/coinmarketcat/console/` — and press **Connect Phantom**.
   Phantom injects its provider into web pages only, so signing happens in that tab.
   **Keep it open.**
4. In the popup choose **Observe**. Watch the shadow book fill. Export it, grade it.
5. To arm: choose **Execute**, read the checklist, type the sentence the lane prints for
   the wallet that will sign (Phantom's, or the autopilot wallet's), press **Arm**. It is compared byte for byte, as WALL-ST-E does
   with `SNIPE_LIVE_ACK`. A ticket above the 0.005 SOL canary must also have a stop you
   chose.

`npm run watch` rebuilds on save; press the reload arrow on the extension card afterwards.

## What it refuses, and what you must know

- **A stop that needs a click is a weaker stop than a key's.** In Phantom mode every exit is one Phantom
  window. A declined sell is asked again 8 s later, and an unanswered window is abandoned
  after 32 s and asked again, for as long as the determiner still says sell; the lane
  fires a notification and puts SELL on the badge. It cannot press Approve for you.
- **In Phantom mode, close the console tab and the lane loses its signer.** Open
  positions are still yours, and still priced, but nothing can be sold until it is back.
  On autopilot the tab is needed only to fund; a locked autopilot wallet is the same stop.
- **A buy window that sits past 25 s is abandoned.** A declined buy is never re-asked.
- **One live position at a time** by default, on either signer.
- **The checklist is the condition.** The sentence alone does not arm: every item the popup
  lists under "Before this lane may spend money" must be green (a stock listed with no stop
  chosen, for one, keeps the lane unarmed with the sentence typed).
- **A curve that has graduated to a pool cannot be sold by this lane** — it sells on the
  curve only. The row says SELL BY HAND; sell it yourself, then press **Forget**.
- **The manifest is the charter.** Permissions are `storage`, `alarms`, `notifications`;
  the content script matches the console pages only; `injected.js` is the only
  web-accessible resource. Widening any of it (beyond `unlimitedStorage`, which the test
  tolerates) fails `test-hawk-manifest.mjs`. The xStock venue added no permission: its
  requests to api.jup.ag, api.geckoterminal.com and api.dexscreener.com (and datapi.jup.ag if
  you choose that feed) are fetches under the same https host permission the RPC uses.
- **Exactly one file may hold a key, and only on autopilot.** In Phantom mode the
  extension holds no key at all. On autopilot the key lives in `src/lib/session-wallet.mjs`
  and nowhere else: `test-hawk-no-key.mjs` scans every source file on every run, and the
  built bundle in `dist/` whenever one is present (build first, then `npm test`), for a
  Keypair, a secret, a derivation or a signer outside that file; pins that only the
  service worker imports it; that the unlocked key goes to session storage only; that
  only the create, unlock and export messages carry a passphrase and only the export
  returns a key; that no message carries transaction bytes from a page; and that nothing
  logs or stores either. `test-hawk-autopilot.mjs` checks the same through the running
  worker. Either way, the engine refuses to send any signed transaction whose message is
  not the one it asked to have signed.
- **Two RPCs are optional here; on the executor they are mandatory.** A single provider
  is a single witness; the shadow row's `endpointVerdict` says `single` when so.

## How it is built

```
manifest.json            MV3; permissions pinned by test-hawk-manifest.mjs
build.mjs                esbuild; a plugin swaps node:crypto and jupiter.mjs for src/shims/
src/background.mjs       the service worker: hosts the engine, the bridge, the autopilot wallet's keystore, fund and sweep, the badge, notifications
src/content.mjs          on the console page only: injects injected.js, relays with a nonce
src/injected.mjs         in the page's world: the only code that touches window.phantom.solana
src/lib/engine.mjs       the lane — dependency-injected, runs in Node for its tests
src/lib/config.mjs       the dials, the arming checklist, RECORD
src/lib/rpc.mjs          a small JSON-RPC client and the logsSubscribe feed with its watchdog
src/lib/tx.mjs           transaction assembly (mirrors snipe-execute.mjs) and the fill reader
src/lib/xstock-lane.mjs  the second venue: new pools paired with a stock — its gates, its book, its entries and exits
src/lib/xstock-discovery.mjs  the new-pool feeds: parsers, pair classification, dedupe, backoff
src/lib/jupiter-swap.mjs the Jupiter client (0.5 requests a second) and the check before signing (a port of the executor's)
fixtures/xstock-pools/   the feeds' and Jupiter's live answers, captured 2026-09-24, that the tests replay
src/lib/session-wallet.mjs  the autopilot wallet: keystore, signer, fund and sweep builders — the one file that may hold a key
src/popup/ src/options/  the UI
src/welcome/             the first-run setup page, opened once on install
vendor/executor/         the executor's decision modules, verbatim, from PROVENANCE.json's commit
scripts/sync-executor.mjs  --from <checkout> re-vendors; --check reports drift from upstream main
site/                    the website: the landing page, and under console/ the page Phantom lives on
```

What a buy is, end to end: the feed's `logsSubscribe` notice → `noticesFromLogs` (the
venue's own parser) → one `getMultipleAccounts` (curve, Global, mint) → `snipeContract`
in observe mode → a would-have position and a shadow row → the wait → a fresh read →
`planSnipeCeiling` → `buyIx` → `snipeContract` in execute mode, which decodes the bytes
back and matches them to the plan → a v0 transaction (compute budget, idempotent ATA
create, `buy_v2`) → **simulated on your RPC with a spend ceiling and a delivery floor** →
one Phantom window → the signed bytes are checked to be the same message → sent with
preflight skipped → confirmed → the fill read from the transaction's own balances →
booked, charged to the rolling day. A sell is the same path with `sell_v2`.

A buy in the xStock venue: a feed's pool → the gates above → one `getMultipleAccounts` (the
new token, audited; the stock, described) → Jupiter's quote in and quote back out → a
would-have position → the wait → the same again, fresh → Jupiter's transaction → decoded and
bound, lookup tables from your RPC → the wallet's other accounts proved untouched → the
engine's simulate guard → one Phantom window (or the autopilot key) → the same-message check →
sent → confirmed → the fill read from the transaction → booked in the stock.

## Keeping the decision code honest

```bash
npm run check-upstream                          # does vendor/executor still match Claude-Company main?
node scripts/sync-executor.mjs --from ../Claude-Company   # re-vendor from a checkout, record its commit
```

`test-vendor-integrity.mjs` refuses a vendored file whose bytes do not match the
manifest, so a hand edit under `vendor/` fails the suite by name. CI runs the drift check
on every push to `main`.

## Tests

`npm test` runs every `test-*.mjs` at the root and under `vendor/executor/`:

| file | proves |
|---|---|
| `test-hawk-engine.mjs` | the lane end to end against a scripted chain that executes the venue's own `buy_v2`/`sell_v2` and a scripted Phantom: notice → shadow row → the wait → re-read → sign → fill → 1.5× take → declined sell re-asked → approved sell closes with the chain's SOL; a launch nobody followed is never bought; a declined or unanswered buy; a tampered signature refused; the day cap; the hard stop; the JSONL export read back and scored. Then a GLDx-quoted curve built from the live fixture bytes: refused when GLDx is not listed; read on the same call and filed in GLDx when it is; the canary buy with the GLDx account created under Token-2022, simulated on the GLDx delta, read back in eight decimals; the sell for GLDx; the full ticket once proven; the per-stock day cap and the SOL day; a short wallet, a paused stock, a buy that cannot be read back; SOL and GLDx graded apart; the stock list's validation and the arm sentence; the fill reader alone |
| `test-hawk-engine.mjs` §18 | autopilot with the real session wallet (a keystore over Maps, `createSessionSigner`): locked it does not arm; unlocked and funded it arms on the autopilot sentence; the buy and the sell reaching the chain carry ed25519 signatures by the autopilot key and Phantom is asked nothing; the key reaches no log, notification or store; a wallet short of one buy does not arm, and one that fell short since the last read is refused at `autopilot_balance_short`; switching to Phantom never strands a position; locked, a sell waits and says so; an unlock that runs out disarms |
| `test-hawk-autopilot.mjs` | the running service worker under a `chrome` double and a JSON-RPC chain double that verifies every signature and applies the rent rule: install opens the setup page once; the three styles against the defaults dial by dial; only extension pages drive the wallet; create, fund (one Phantom approval, SOL and GLDx by TransferChecked), unlock with a TTL and its alarm, export, sweep to exactly the rent floor with every token and empty account, lock, an unlock that runs out; nothing logged or stored carries the passphrase or the key; no sweep while a position is held |
| `test-hawk-session-wallet.mjs` | the keystore, the signer and the builders in isolation, including why a token sweep is TransferChecked: Token-2022 refuses a plain Transfer out of an xStock's pausable, hooked account |
| `test-hawk-manifest.mjs` | the permissions, matches and resources above; the setup page is built, not web-accessible, and opened only on install |
| `test-hawk-no-key.mjs` | one file may hold a key and only the worker imports it; the autopilot messages, the passphrase and the exported key pinned to where they may appear; the xStock venue's code names only its four hosts, sends Jupiter the wallet's public key and nothing else of it, and reaches a signature only through the engine's `signSendConfirm`, each call after its own pre-sign check; in source and in the bundle |
| `test-hawk-xstock-venue.mjs` | the second venue against a chain double that runs Jupiter's `route_v2` on a constant-product pool, a scripted Jupiter and scripted feeds, no network: the venue off by default and silent; the captured GeckoTerminal and DexScreener pages parsed and classified; the poller's backoff on the captured 429, dedupe and horizon; the Jupiter client's rate budget; the quote and transaction checks on the **live** GLDx → GAYMF bytes and every hostile edit of them; observe with each gate refusing by name; armed on Phantom: wait, follow-through, buy, 1.5× take, sell, booked in GLDx; ten hostile Jupiter transactions and two hostile pools refused before signing; the canary, full ticket, day caps and a short wallet; an unreadable buy blocking the stock; autopilot signing with nothing secret on the wire; the pump.fun lane unchanged |
| `test-hawk-bundle.mjs` | the shims agree with what they replace; the build succeeds; every entry parses with no `node:` specifier; the bundled contract refuses a stale notice at the same gate the vendored contract does |
| `test-vendor-integrity.mjs` | every vendored module hashes to the manifest, from a named upstream commit |
| `vendor/executor/test-snipe-stall-default.mjs` | the executor's stall-default fix, as vendored |
| `vendor/executor/test-snipe-quote-mint.mjs` | the executor's stock-quote contract, as vendored: the allowlist, `quoteTicketFor`, `describeMint` on the live xStock bytes, the book row at eight decimals, one scorecard per quote |

## Not advice

A user-operated tool that runs in your own browser against your own wallet. Nothing here
is financial advice, nothing here has an edge until you have graded its book over a real
sample. In Phantom mode every position it opens can be sold only by a click you make; on
autopilot it sells without asking, from a wallet that can lose everything you fund it with.
