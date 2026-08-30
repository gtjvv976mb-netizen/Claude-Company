# Claude Company — Reference Executor

**Auto-trade the desk's calls without ever handing over your funds.**

The desk (Claude or Grok) is the **brain**: it researches and publishes calls, and
never touches a wallet. This script is the **hands**: it runs on *your* machine, holds
*your* burner wallet, and obeys *your* caps. The building POSTs every entry and exit
your floor receives here as signed JSON; this verifies the signature and trades via
Jupiter — buying on entry, selling everything on exit.

## Why this is safe
- **You keep custody.** The desk cannot reach this wallet. It only sends suggestions,
  and each one is signed with your floor's secret — an attacker without that secret
  cannot forge a call.
- **Burner wallet.** Fund it only with what you're willing to lose entirely.
- **Dry run by default.** Nothing trades until you set `EXECUTE=1`.
- **Hard caps enforced here.** Per-trade and daily SOL limits are checked locally and
  never trusted from anyone — the desk suggested 0.2 SOL in testing, the cap held it to 0.05.

## Setup
1. On your floor's **Calls tab → Desk settings → Your executor**, paste this machine's
   public URL and copy the **signing secret** it shows.
2. Make a burner wallet: `solana-keygen new -o burner.json` — fund it with a little SOL.
3. `npm install`
4. Run in **dry run** first and watch it decide:
   ```bash
   CC_SECRET=<your signing secret> KEYPAIR=./burner.json \
   MAX_SOL_PER_TRADE=0.05 DAILY_SOL_CAP=0.5 EXECUTE=0 npm start
   ```
5. When you trust it, flip `EXECUTE=1`.

## Two ways to run it

**Recommended — the poller (`poller.mjs`): no public URL needed.**
It polls your floor's calls over plain outbound HTTPS, so it runs *anywhere* — your
laptop, a $4 VPS, a Raspberry Pi — with no tunnel and no exposed port. In the executor
panel you can paste any https URL (even a dummy) just to mint your secret; the poller
never receives webhooks.
```bash
CC_SECRET=<secret> CC_FLOOR=<your floor #> KEYPAIR=./burner.json MAX_SOL_PER_TRADE=0.05 DAILY_SOL_CAP=0.5 EXECUTE=0 node poller.mjs
```
Fund the burner, start it once, walk away — it trades your floor's calls hands-off.
For 24/7 (so it trades while your laptop sleeps), put it on a tiny always-on VPS.

**Alternative — the webhook receiver (`executor.mjs`): needs a public URL.**
The building POSTs to it. Reachable via a Cloudflare tunnel
(`cloudflared tunnel --url http://localhost:8787`) or a VPS, with the URL pasted into the
executor panel. Same safety and caps; use this only if you'd rather receive pushes than poll.


## The risk engine (why this is a bot, not a relay)

Between the desk's entry and its exit, a naive relay is naked — if the desk's
monitor is slow, or your box slept, or the token rugs in ninety seconds, nothing
protects the position. The poller runs its own risk engine every poll:

- **Hard stop**, checked every tick, on an *executable* Jupiter quote for the exact
  size you hold (not a mid price) — the stop fires on what you could really sell for.
- **Breakeven + trail**: the moment the call's target is touched, the stop lifts to
  your entry (the trade can no longer lose), then ratchets up behind the high.
- **The desk's exit always wins** and sells everything — it sees rugs and dead theses
  the price hasn't shown yet.
- **Daily loss limit** and **max open positions** — the two brakes that decide whether
  a bot survives a bad week.
- State is persisted, so a restart resumes managing open trades instead of orphaning them.

### The parameters were tuned by simulation, not by feel

`npm run tune` sweeps the settings over seeded, fat-tailed price paths. It found
something counterintuitive and expensive: **every scale-out setting reduced mean P&L.**
Memecoin returns are fat-tailed — the rare runners carry the entire edge — so selling
half at target quietly destroys the thing you're being paid for. The shipped default is
therefore *no scale-out* with a wide trail.

Measured against a naive bot on identical call streams (300 runs x 60 calls):

| desk win rate | naive mean | managed mean | naive bad-run (p10) | managed bad-run | naive drawdown | managed drawdown |
|---|---|---|---|---|---|---|
| 20% | +0.053 | **+0.056** | -0.155 | **-0.135** | -0.236 | **-0.187** |
| 28% | +0.079 | **+0.080** | -0.151 | **-0.113** | -0.233 | **-0.187** |
| 40% | +0.119 | +0.117 | -0.112 | **-0.090** | -0.207 | **-0.188** |

Same expected return, materially smaller losses when things go wrong.

### The break-even, with real trading costs

The table above ignores trading costs, and that flattered it badly — it showed a profit
even at a 5% win rate, which no honest memecoin strategy does. Charging a realistic 6%
round trip (entry + exit slippage, spread, priority fees) gives the number that actually
matters:

| desk win rate | mean P&L (risk-managed) |
|---|---|
| 10% | **-0.036 SOL (loses)** |
| 20% | **-0.011 SOL (loses)** |
| 25% | ~break-even |
| 40% | +0.046 SOL |
| 55% | +0.090 SOL |

**The desk must hit roughly 25% for this bot to make money at all.** Below that, costs
eat the edge and you lose slowly no matter how good the risk engine is.

**Read this honestly:** the simulation does NOT show this bot is profitable. It shows it
is profitable *if* the desk's calls clear ~25%, and the price model behind that is one I
wrote — not a backtest against real fills. Profit is a function of the desk's call
quality, not of this bot. No bot can promise a profit on memecoins, and anyone who tells
you otherwise is selling something. What the engine does is make sure a real edge isn't
destroyed by one bad night, and that a bad streak can't compound into a blown account.

Run `npm run simulate -- --cost 0.10 --winrate 0.15` to see how quickly it turns
negative under worse assumptions. Do that before you fund anything.

```bash
npm test        # 15 risk-engine cases: stops, trails, caps, desk exits
npm run simulate    # naive vs risk-managed on the same call stream
npm run tune        # re-sweep the parameters yourself
```

## Knobs (env vars)
| var | default | meaning |
|---|---|---|
| `CC_SECRET` | — (required) | your floor's signing secret |
| `KEYPAIR` | `./burner.json` | path to the wallet file |
| `EXECUTE` | `0` | `1` to actually trade |
| `MAX_SOL_PER_TRADE` | `0.05` | ceiling per entry |
| `DAILY_SOL_CAP` | `0.5` | ceiling per rolling 24h |
| `SLIPPAGE_BPS` | `300` | 3% max slippage |
| `DAILY_LOSS_LIMIT_SOL` | `0.15` | realized losses that stop new entries for the day |
| `MAX_OPEN_POSITIONS` | `4` | most positions held at once |
| `TRAIL_PCT` | `0.60` | trail this far under the high, once armed |
| `SCALE_OUT_PCT` | `0` | sell this fraction at target (0 = ride the runners) |
| `SOLANA_RPC` | public mainnet | use your own RPC for reliability |
| `PORT` | `8787` | listen port |

This is a **reference** — deliberately small and readable so you can audit every line
before trusting it with money. Fork it, add your own logic, or point the same webhook
at a bot you already run.
