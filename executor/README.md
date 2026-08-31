# WALL-ST-E — Claude Company’s self-hosted executor

WALL-ST-E is the autotrading representative for your floor. The central Claude
Company site publishes authenticated research calls; it does not custody funds,
receive wallet keys, sign transactions, or know whether your executor is running.

The polling executor runs on a machine you control. It starts in **dry run** unless
you deliberately install it with `--live`. Browser signing and webhook execution
remain disabled; the only live-capable path is the local `poller.mjs` service.

Trading is risky, and these controls do not make the calls profitable. Use a new,
dedicated burner wallet and fund it with no more than you can lose.

## The first-start rule

On its first successful feed read, WALL-ST-E records the newest delivery ID and
skips everything older. It does **not** replay calls that were published before the
poller started. This is true in dry-run and live mode.

After that cursor is established, only later deliveries are eligible. Do not delete
the state database to force a replay; reconcile the journal and wallet first.

## Default installation: dry run

Install from the exact 40-character release commit shown by the floor UI. Review the
checkout before running it; live mode refuses piped/mutable runtime downloads. Node
22.13+ must already be installed from a package source you trust. The installer asks for
the floor’s executor feed secret through `/dev/tty`, creates a dedicated unfunded burner
locally, stores secrets at mode `0600`, and installs a systemd service.

```bash
git clone https://github.com/gtjvv976mb-netizen/Claude-Company.git
cd Claude-Company
git checkout --detach <PUBLISHED_COMMIT_SHA>
bash executor/install.sh --floor <YOUR_FLOOR_NUMBER>
```

Dry run downloads the same calls and applies the same local policy without signing
or submitting a transaction. Check its decisions before considering live mode:

```bash
sudo journalctl -u cc-executor -f
```

For unattended feed authentication, create a mode-`0600` secret file and add
`--secret-file`:

```bash
umask 077
install -m 600 /dev/null ./claudeco-secret
${EDITOR:-vi} ./claudeco-secret
bash executor/install.sh --floor <YOUR_FLOOR_NUMBER> \
  --secret-file ./claudeco-secret
```

`CC_SECRET` authenticates the read-only floor feed. It is not a wallet key and
cannot move funds.

## Explicit live installation

Live mode requires all of the following:

- a dedicated burner wallet generated and held on the executor host;
- two private HTTPS Solana RPC endpoints from independent providers, each supplied from
  its own mode-`0600` file;
- a Jupiter API key supplied from a mode-`0600` file;
- `--live` on the installer command;
- caps for a supervised canary; and
- a terminal acknowledgement made by retyping the displayed burner public key.

Prepare the Jupiter key and RPC files without putting credentials in shell history:

```bash
umask 077
install -m 600 /dev/null ./jupiter-api-key
install -m 600 /dev/null ./primary-rpc
install -m 600 /dev/null ./secondary-rpc
${EDITOR:-vi} ./jupiter-api-key
${EDITOR:-vi} ./primary-rpc
${EDITOR:-vi} ./secondary-rpc
```

The first live release is hard-capped at **0.005 SOL per trade** and
**0.01 SOL in every rolling 24-hour window**, including finalized entry fees and fees
paid by failed on-chain attempts. Environment edits cannot raise those ceilings:

```bash
bash executor/install.sh --floor <YOUR_FLOOR_NUMBER> \
  --live \
  --expected-commit <PUBLISHED_COMMIT_SHA> \
  --max-sol 0.005 \
  --daily-cap 0.01 \
  --rpc-file /absolute/path/to/primary-rpc \
  --secondary-rpc-file /absolute/path/to/secondary-rpc \
  --jupiter-key-file /absolute/path/to/jupiter-api-key
```

Use genuinely independent providers for the two RPC files, not two
API keys or paths on the same provider. The secondary endpoint is read-only and is
used to prevent a missing or lagging primary history response from authorizing a
duplicate replacement transaction. Live installation refuses the public Solana RPC,
an omitted secondary endpoint, or endpoints with the same provider hostname.

The installer prints the dedicated burner’s **public** key and asks you to
retype it through the terminal. That exact value becomes `LIVE_TRADING_ACK`. The
service refuses live mode if the acknowledgement, wallet, API key, both private RPCs,
state database, or required file permissions do not pass startup checks.

`EXECUTE=1` by itself is not an activation procedure. Do not paste a private key,
Jupiter key, or executor feed secret into Claude Company or a command-line argument.
Keep the private RPC configuration on the executor host. Fund only the displayed
burner address, only after confirming the installed paths and dry-run output.

## What remains local

The host keeps:

- `burner.json`, the dedicated wallet key;
- the mode-`0600` environment file and API credentials;
- `STATE_DB`, the durable cursor, position record, and transaction journal; and
- the pause/hard-stop sentinel files.

The central site keeps none of those items. It cannot start, pause, or inspect the
local service, and the browser must not display “LIVE” without executor telemetry.
Verify the real mode, wallet address, signatures, and fills in the host logs and on a
Solana explorer you trust.

The legacy `executor.mjs` webhook adapter verifies signed event envelopes for dry-run
testing only. It cannot sign or broadcast trades. The browser transaction relay is
also disabled.

## Transaction safety and recovery

Live polling uses `jupiter.mjs` for Jupiter Swap API v2 order validation and execution
and `journal.mjs` for durable intent/attempt records. Before a transaction is signed,
the executor checks the intended wallet, mints, amount, fees, price impact, expiry,
resolved v0 program instructions, payer/signers, transaction size, and RPC simulation.

The first live canary accepts only Jupiter Metis exact-in routes and classic SPL Token
mints. Token-2022 routes fail closed. Source and destination custody must be the wallet’s
canonical associated token accounts, with no delegate, close authority, frozen state, or
unexpected writable wallet-owned token account.

The journal is written before submission. If submission has an ambiguous network
result, the executor reconciles the recorded signature and retries the same signed
attempt when safe; it does not silently create a second order. Confirmed entries and
exits are applied idempotently, using actual input/output amounts returned by Jupiter
and verified on chain.

Never delete `STATE_DB` or edit a journal row to clear an uncertain attempt. Engage
the hard stop, inspect the signature and wallet on chain, and reconcile the holding
before restarting. The executor manages only positions it recorded; unrelated wallet
assets are outside its book.

Entry orders keep the strict `MAX_PRICE_IMPACT_PCT` cap. Exit marks are still observed
when impact exceeds that entry cap so stop, age, and desk-exit policy cannot disappear
during a liquidity collapse. Signed exits use the separate
`MAX_EXIT_PRICE_IMPACT_PCT` emergency cap (50% by default). If an exit exceeds that cap,
the durable position is retained, new entries are blocked, and the host logs
`MANUAL EXIT REQUIRED`; the operator must reconcile or exit from the burner wallet.

## Pause and hard stop

The installer records explicit paths in the protected environment file:

- If the file named by `PAUSE_ENTRIES_FILE` exists, WALL-ST-E refuses new buys but
  continues monitoring, closing recorded positions, and reconciling pending attempts.
- If the file named by `HARD_STOP_FILE` exists, WALL-ST-E creates no new submissions,
  including automated exits. It still reconciles transactions that were already
  signed or submitted. Existing positions require operator supervision or manual
  management while the sentinel remains present.

The service also refuses to run a second live process against the same `STATE_DB`.
An active, unreadable, or invalid-owner lock fails closed. A lock whose recorded PID is
provably absent is atomically quarantined and reclaimed; competing restarts still resolve
to one owner. Never delete a lock manually while an executor may be alive.
Inspect `sudo journalctl -u cc-executor -f` after changing either sentinel. Stopping
the systemd service is the host-level emergency brake:

```bash
sudo systemctl stop cc-executor
```

Stopping the process does not close an on-chain position.

## Shared snipe-v2 policy

The server record and executor import the same `trade-policy.mjs` rules:

- The desk’s explicit exit closes the recorded position in full.
- The authored stop is enforced.
- At `1.35x`, the stop ratchets to breakeven.
- At `1.5x`, a 25% trailing stop begins ratcheting behind the high.
- Auto mode closes in full at the authored target or shared `2x` default, whichever
  arrives first. An explicit multiple such as `10x` overrides the authored target;
  a later desk exit still wins.
- An unresolved position reaches its age exit at 12 hours.
- Snipe-v2 does not emit a partial exit; legacy `SCALE_OUT_PCT` values are ignored.

Sizing also applies the stop requirement, estimated round-trip costs, sample/Kelly
gate, per-name risk ceiling, book-heat ceiling, rolling 24-hour deployment cap and
rolling 24-hour realized-loss
limit, available balance, and maximum-open-position rule. These are loss controls,
not evidence of an edge.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `CC_SECRET` | required | Read-only floor-feed credential; store only in the protected env file |
| `CC_FLOOR` | required | Floor number bound to the feed |
| `KEYPAIR` | generated `burner.json` | Dedicated local wallet; must be mode `0600` |
| `EXECUTE` | `0` | `1` requests live mode but is insufficient without every other live gate |
| `LIVE_TRADING_ACK` | unset | Must exactly match the loaded burner public key in live mode |
| `JUPITER_API_KEY` | unset | Required locally for Jupiter Swap API v2 in live mode |
| `SOLANA_RPC` | public default in dry run | A private HTTPS provider is required in live mode |
| `SOLANA_RPC_SECONDARY` | required in live mode | Independent private-provider expiry cross-check; an outage halts instead of risking a duplicate |
| `STATE_DB` | installer-managed | Durable cursor, positions, transaction journal, and wallet binding |
| `PAUSE_ENTRIES_FILE` | installer-managed | Presence blocks new entries while allowing managed exits |
| `HARD_STOP_FILE` | installer-managed | Presence blocks new submissions while reconciliation continues |
| `MAX_SOL_PER_TRADE` | installer value | Absolute input ceiling for one entry; live hard maximum `0.005` SOL |
| `DAILY_SOL_CAP` | installer value | Rolling 24-hour deployment cap; live hard maximum `0.01` SOL |
| `DAILY_LOSS_LIMIT_SOL` | policy default | Rolling 24-hour realized-loss brake, including failed-attempt fees |
| `MAX_OPEN_POSITIONS` | policy default | Concurrent recorded-position ceiling |
| `SLIPPAGE_BPS` | policy default | Maximum requested swap slippage |
| `MAX_PRICE_IMPACT_PCT` | `5` | Strict maximum impact for a new entry |
| `MAX_EXIT_PRICE_IMPACT_PCT` | `50` | Emergency impact ceiling for a managed exit; above it requires manual action |
| `MAX_NETWORK_FEE_LAMPORTS` | `500000` live ceiling | Absolute network-fee cap, checked before signing and at finality |
| `MAX_NETWORK_FEE_PCT` | `10` live ceiling | Network-fee cap relative to exact trade basis |
| `MAX_RENT_LAMPORTS` | `3000000` live ceiling | Separate account-rent cap; rent is not treated as a network fee |
| `MAX_ENTRY_ROUND_TRIP_LOSS_PCT` | `12` live ceiling | Maximum measured forward/reverse entry preflight loss |
| `MAX_ENTRY_MARK_AGE_MIN` | `15` | Maximum monitored USD-mark age at entry submission |
| `TRAIL_PCT` | `0.25` | Trail distance after the shared 1.5x arm |
| `MAX_AGE_HOURS` | `12` | Time exit used by snipe-v2 |

Do not hand-edit `LIVE_TRADING_ACK` to bypass the installer. Re-run the reviewed
installer if you intentionally change modes, wallets, credentials, RPCs, or caps. An
upgrade stages and validates a versioned release before stopping the active service,
checkpoints and backs up the journal, atomically switches the `current` symlink, and
restores the previous unit, environment, journal, and release if activation fails.

## Manual development and verification

For a local dry run from this directory:

```bash
npm install
umask 077
solana-keygen new -o ./burner.json
chmod 600 ./burner.json
CC_SECRET=replace_with_feed_secret CC_FLOOR=replace_with_floor_number \
  KEYPAIR=./burner.json EXECUTE=0 npm start
```

Run the policy, sizing, simulation, tuning, and installer tests before deployment:

```bash
npm test
npm run test:sizing
npm run simulate
npm run tune
npm run test:install
```

Synthetic tests and simulations do not establish live expectancy. A supervised
canary means watching the service, journal, wallet balance, order signatures, and
actual fills—and being ready to pause entries or stop the service.
