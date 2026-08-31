# Claude Company — Reference Executor

## Dry-run hardening release

This release does **not** trade. Both `poller.mjs` and `executor.mjs` reject
`EXECUTE=1` at startup before a transaction can be built, signed, or submitted.

The executor remains available so operators can audit the code, verify their floor
feed, exercise the shared risk policy, and run simulations while the durable
transaction journal and instruction-level Jupiter validation are completed. Do not
fund the generated burner wallet for auto-trading in this release.

The custody boundary is unchanged: the central desk publishes research calls and
never receives a private key. The optional executor runs on the operator's machine.

## Recommended installation

The installer prompts for the floor secret through the terminal. It does not put the
secret in the command line, shell history, or systemd unit.

```bash
curl -fsSL https://claudedotcompany.com/executor/install.sh | bash -s -- \
  --floor <YOUR_FLOOR_NUMBER>
```

For unattended installation, prepare a secret file without printing the secret in a
command:

```bash
umask 077
install -m 600 /dev/null ./claudeco-secret
${EDITOR:-vi} ./claudeco-secret
curl -fsSL https://claudedotcompany.com/executor/install.sh | bash -s -- \
  --floor <YOUR_FLOOR_NUMBER> --secret-file ./claudeco-secret
```

The installer copies the value into
`$HOME/claudeco-executor/.cc-executor.env`, sets that file and the burner key to mode
`0600`, and gives systemd only an `EnvironmentFile=` reference. The service starts
with `EXECUTE=0` and there is no supported switch to arm it in this release.

Optional installer flags are `--max-sol`, `--daily-cap`, `--rpc`, `--api`, and
`--static`. The caps are retained for policy evaluation and for a future, separately
reviewed live release; they do not authorize transactions now.

## Manual dry-run setup

```bash
npm install
umask 077
solana-keygen new -o ./burner.json
chmod 600 ./burner.json
install -m 600 /dev/null ./.cc-executor.env
${EDITOR:-vi} ./.cc-executor.env
set -a
. ./.cc-executor.env
set +a
npm start
```

Use this shape inside `.cc-executor.env`:

```dotenv
CC_SECRET=your_floor_secret
CC_FLOOR=your_floor_number
KEYPAIR=/absolute/path/to/burner.json
MAX_SOL_PER_TRADE=0.05
DAILY_SOL_CAP=0.5
EXECUTE=0
```

Keep the env file and keypair at mode `0600`. `CC_SECRET` authenticates the read-only
floor feed; it is not a wallet key.

## What the poller does in this release

The recommended adapter is `poller.mjs`. It makes outbound HTTPS requests to the
floor feed, ignores historic entries on first start, evaluates new entries against
local caps, and logs dry-run decisions. No public URL is required.

If an upgrade finds positions in an older state file, simulated exits retain those
records because this release cannot perform the matching on-chain sale. Reconcile any
real legacy holdings manually before replacing or clearing that state file.

`executor.mjs` is the webhook reference adapter. It verifies signed v2 events and
logs dry-run decisions, but live webhook execution is also intentionally disabled.
It is not presented as a production trading service.

## Shared snipe-v2 policy

The server record and executor import the same `trade-policy.mjs` policy:

- The desk's explicit exit always closes the position in full.
- The authored stop is enforced.
- At `1.35x`, the stop ratchets to breakeven.
- At `1.5x`, a 25% trailing stop begins ratcheting behind the high.
- Auto mode closes in full at the authored target or shared `2x` default, whichever
  is reached first. An explicit multiple such as `10x` overrides the authored target;
  the desk's later explicit exit still always wins.
- An unresolved position reaches its age exit at 12 hours.
- Snipe-v2 never emits a partial exit; legacy `SCALE_OUT_PCT` values are ignored by
  the price policy.

Position sizing still applies the stop requirement, estimated round-trip costs,
sample-size/Kelly gate, per-name risk ceiling, book-heat ceiling, daily deployment
cap, daily loss limit, and maximum-open-position rule. These controls are research
logic, not evidence that the desk has a profitable edge.

## Verification

```bash
npm test
npm run test:sizing
npm run simulate
npm run tune
```

The strategy tests cover shared-policy identity, stops, full target exits, ratchets,
caps, sizing, desk exits, and the age boundary. Simulations are synthetic research;
they do not establish live expectancy or authorize enabling execution.

## Configuration

| Variable | Default | Meaning in this release |
|---|---:|---|
| `CC_SECRET` | required | Floor-feed credential; store only in the mode-0600 env file |
| `CC_FLOOR` | required for poller | Floor number bound to the feed |
| `KEYPAIR` | `./burner.json` | Local dry-run identity; do not fund for auto-trading |
| `EXECUTE` | `0` | Must remain `0`; `1` is rejected at startup |
| `MAX_SOL_PER_TRADE` | `0.05` | Local sizing ceiling used in dry-run evaluation |
| `DAILY_SOL_CAP` | `0.5` | Local deployment ceiling used in dry-run evaluation |
| `DAILY_LOSS_LIMIT_SOL` | `0.15` | Local realized-loss brake |
| `MAX_OPEN_POSITIONS` | `4` | Local concurrent-position ceiling |
| `SLIPPAGE_BPS` | `300` | Reserved transaction setting; no transaction is sent |
| `TRAIL_PCT` | `0.25` | Trail distance after the shared 1.5x arm |
| `MAX_AGE_HOURS` | `12` | Time exit used by snipe-v2 |
| `JUPITER_API_BASE` | current Lite Swap API | Reserved quote/build endpoint |
| `SOLANA_RPC` | public mainnet | RPC endpoint; a private provider is required before any future live canary |
| `STATE_FILE` | `./.cc-state.json` | Local cursor and dry-run state |

## Live activation

There is no live activation procedure in this release. A future live build requires
a durable write-ahead transaction journal, exact-once crash recovery, strict Jupiter
transaction validation, actual-fill accounting, fault-injection tests, and an
explicitly supervised burner-wallet canary. Changing the env file to `EXECUTE=1`
today causes a deliberate startup failure.
