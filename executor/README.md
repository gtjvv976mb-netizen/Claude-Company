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

## Knobs (env vars)
| var | default | meaning |
|---|---|---|
| `CC_SECRET` | — (required) | your floor's signing secret |
| `KEYPAIR` | `./burner.json` | path to the wallet file |
| `EXECUTE` | `0` | `1` to actually trade |
| `MAX_SOL_PER_TRADE` | `0.05` | ceiling per entry |
| `DAILY_SOL_CAP` | `0.5` | ceiling per rolling 24h |
| `SLIPPAGE_BPS` | `300` | 3% max slippage |
| `SOLANA_RPC` | public mainnet | use your own RPC for reliability |
| `PORT` | `8787` | listen port |

This is a **reference** — deliberately small and readable so you can audit every line
before trusting it with money. Fork it, add your own logic, or point the same webhook
at a bot you already run.
