#!/usr/bin/env bash
# Claude Company — one-command poller install.
#
# Stands up the polling executor on any Linux box (a $4/mo VPS, a Raspberry Pi)
# in about a minute: installs Node if missing, fetches the poller, generates a
# BURNER wallet, writes a systemd service so it runs 24/7 and survives reboots,
# and starts it in DRY RUN. Nothing trades until you fund the burner and flip
# EXECUTE=1 — the script tells you exactly how at the end.
#
#   curl -fsSL https://claudedotcompany.com/executor/install.sh | bash -s -- \
#     --secret <YOUR_EXECUTOR_SECRET> --floor <YOUR_FLOOR_NUMBER>
#
# Optional flags: --max-sol 0.05  --daily-cap 0.5  --api https://...
set -euo pipefail

SECRET=""; FLOOR=""; MAX_SOL="0.05"; DAILY_CAP="0.5"
API="https://claude-company-api.onrender.com"
STATIC="https://claudedotcompany.com"
while [ $# -gt 0 ]; do
  case "$1" in
    --secret) SECRET="$2"; shift 2;;
    --floor) FLOOR="$2"; shift 2;;
    --max-sol) MAX_SOL="$2"; shift 2;;
    --daily-cap) DAILY_CAP="$2"; shift 2;;
    --api) API="$2"; shift 2;;
    --static) STATIC="$2"; shift 2;;
    *) echo "unknown flag: $1"; exit 1;;
  esac
done
[ -n "$SECRET" ] && [ -n "$FLOOR" ] || { echo "need --secret and --floor"; exit 1; }

DIR="$HOME/claudeco-executor"
echo "▶ installing the Claude Company poller into $DIR"

# Node 20+ if absent
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 20 ]; then
  echo "▶ installing Node.js…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - >/dev/null 2>&1 || true
  sudo apt-get install -y nodejs >/dev/null 2>&1 || { echo "install Node 20+ yourself, then re-run"; exit 1; }
fi

mkdir -p "$DIR" && cd "$DIR"
echo "▶ fetching the poller…"
# Fetch every module the bot needs. poller.mjs imports the risk engine, and an
# install that grabs only the poller produces a bot that dies on its first line.
for f in poller.mjs strategy.mjs; do
  curl -fsSL "$STATIC/executor/$f" -o "$f" || { echo "could not download $f"; exit 1; }
done
# Refuse to install a bot that cannot start, rather than leaving a funded wallet
# attached to a dead service.
node --check poller.mjs >/dev/null 2>&1 || { echo "downloaded poller.mjs is not valid JS — aborting"; exit 1; }
echo '{"name":"cc-exec","private":true,"type":"module","dependencies":{"@solana/web3.js":"^1.95.8"}}' > package.json
npm install --silent >/dev/null 2>&1

# a fresh burner, only if one is not already here
if [ ! -f burner.json ]; then
  echo "▶ generating a BURNER wallet (node keygen — no solana CLI needed)…"
  node -e 'const{Keypair}=require("@solana/web3.js");const fs=require("fs");const k=Keypair.generate();fs.writeFileSync("burner.json",JSON.stringify(Array.from(k.secretKey)));console.log(k.publicKey.toBase58())' > .pubkey
fi
PUBKEY="$(cat .pubkey)"

# systemd service (24/7, restart on reboot). Starts in DRY RUN by design.
SVC="/etc/systemd/system/cc-executor.service"
echo "▶ writing service $SVC (starts in DRY RUN)…"
sudo tee "$SVC" >/dev/null <<UNIT
[Unit]
Description=Claude Company polling executor (floor $FLOOR)
After=network-online.target
[Service]
WorkingDirectory=$DIR
Environment=CC_SECRET=$SECRET
Environment=CC_FLOOR=$FLOOR
Environment=CC_API=$API
Environment=KEYPAIR=$DIR/burner.json
Environment=MAX_SOL_PER_TRADE=$MAX_SOL
Environment=DAILY_SOL_CAP=$DAILY_CAP
Environment=EXECUTE=0
ExecStart=$(command -v node) $DIR/poller.mjs
Restart=always
RestartSec=5
User=$(whoami)
[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable cc-executor >/dev/null 2>&1
sudo systemctl restart cc-executor

cat <<DONE

════════════════════════════════════════════════════════════════
  ✓ Poller installed and running in DRY RUN for floor $FLOOR.

  YOUR BURNER WALLET (fund it with only what you'll risk):
      $PUBKEY

  Watch it decide:      sudo journalctl -u cc-executor -f
  It is NOT trading yet. When you've funded the burner and are ready:

    1) sudo systemctl edit cc-executor --full   # change EXECUTE=0 to EXECUTE=1
    2) sudo systemctl restart cc-executor

  Caps in force: max $MAX_SOL SOL/trade, $DAILY_CAP SOL/day.
  Stop anytime:  sudo systemctl stop cc-executor
════════════════════════════════════════════════════════════════
DONE
