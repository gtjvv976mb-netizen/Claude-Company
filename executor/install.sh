#!/usr/bin/env bash
# Claude Company dry-run poller installer.
#
# The floor secret is read from /dev/tty or a mode-0600 input file. It is copied
# into a mode-0600 EnvironmentFile; it never appears in argv or the systemd unit.
# This release intentionally rejects EXECUTE=1 and must not be funded for trading.
#
# Interactive:
#   curl -fsSL https://claudedotcompany.com/executor/install.sh | bash -s -- \
#     --floor <YOUR_FLOOR_NUMBER>
#
# Unattended:
#   curl -fsSL https://claudedotcompany.com/executor/install.sh | bash -s -- \
#     --floor <YOUR_FLOOR_NUMBER> --secret-file /secure/path/claudeco-secret
#
# Optional: --max-sol 0.05 --daily-cap 0.5 --rpc https://... --api https://...
set -euo pipefail
umask 077

SECRET=""
SECRET_FILE=""
FLOOR=""
MAX_SOL="0.05"
DAILY_CAP="0.5"
RPC=""
API="https://claude-company-api.onrender.com"
STATIC="https://claudedotcompany.com"

need_value() {
  if [ "$#" -lt 2 ] || [ -z "$2" ]; then
    echo "missing value for $1" >&2
    exit 1
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --secret-file) need_value "$@"; SECRET_FILE="$2"; shift 2;;
    --floor) need_value "$@"; FLOOR="$2"; shift 2;;
    --max-sol) need_value "$@"; MAX_SOL="$2"; shift 2;;
    --daily-cap) need_value "$@"; DAILY_CAP="$2"; shift 2;;
    --rpc) need_value "$@"; RPC="$2"; shift 2;;
    --api) need_value "$@"; API="$2"; shift 2;;
    --static) need_value "$@"; STATIC="$2"; shift 2;;
    *) echo "unknown flag: $1" >&2; exit 1;;
  esac
done

case "$FLOOR" in
  ""|*[!0-9]*) echo "--floor must be a positive integer" >&2; exit 1;;
esac
if [ "$FLOOR" -le 0 ]; then
  echo "--floor must be a positive integer" >&2
  exit 1
fi

if [ -n "$SECRET_FILE" ]; then
  if [ ! -f "$SECRET_FILE" ] || [ ! -r "$SECRET_FILE" ]; then
    echo "secret file is not a readable regular file: $SECRET_FILE" >&2
    exit 1
  fi
  SECRET_MODE="$(stat -c '%a' "$SECRET_FILE")"
  if (( (8#$SECRET_MODE & 8#077) != 0 )); then
    echo "secret file must not be readable or writable by group/other (use chmod 600)" >&2
    exit 1
  fi
  IFS= read -r SECRET < "$SECRET_FILE" || true
else
  if [ ! -r /dev/tty ]; then
    echo "no terminal available; pass --secret-file with a mode-0600 file" >&2
    exit 1
  fi
  printf "Claude Company floor secret: " > /dev/tty
  IFS= read -r -s SECRET < /dev/tty
  printf "\n" > /dev/tty
fi

case "$SECRET" in
  ""|*[!0-9A-Fa-f]*)
    echo "floor secret must be the hex value shown by the executor panel" >&2
    exit 1;;
esac
if [ "${#SECRET}" -lt 32 ]; then
  echo "floor secret is unexpectedly short" >&2
  exit 1
fi

number_re='^([0-9]+([.][0-9]*)?|[.][0-9]+)$'
if ! [[ "$MAX_SOL" =~ $number_re ]] || ! [[ "$DAILY_CAP" =~ $number_re ]]; then
  echo "--max-sol and --daily-cap must be positive decimal numbers" >&2
  exit 1
fi
if ! awk -v m="$MAX_SOL" -v d="$DAILY_CAP" 'BEGIN { exit !(m > 0 && d > 0) }'; then
  echo "--max-sol and --daily-cap must be greater than zero" >&2
  exit 1
fi

for endpoint in "$API" "$STATIC" ${RPC:+"$RPC"}; do
  case "$endpoint" in
    https://*) ;;
    *) echo "API, static, and RPC endpoints must use https" >&2; exit 1;;
  esac
  if [[ "$endpoint" =~ [[:space:]#] ]]; then
    echo "endpoint contains whitespace or a fragment marker" >&2
    exit 1
  fi
done

INSTALL_DIR="$HOME/claudeco-executor"
ENV_FILE="$INSTALL_DIR/.cc-executor.env"
echo "▶ installing the Claude Company dry-run poller into $INSTALL_DIR"

if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 20 ]; then
  echo "▶ installing Node.js…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - >/dev/null 2>&1 || true
  sudo apt-get install -y nodejs >/dev/null 2>&1 || {
    echo "install Node 20+ yourself, then re-run" >&2
    exit 1
  }
fi

mkdir -p "$INSTALL_DIR"
chmod 700 "$INSTALL_DIR"
cd "$INSTALL_DIR"

echo "▶ fetching the poller and shared policy…"
for f in poller.mjs strategy.mjs trade-policy.mjs; do
  curl -fsSL "$STATIC/executor/$f" -o "$f" || {
    echo "could not download $f" >&2
    exit 1
  }
  node --check "$f" >/dev/null 2>&1 || {
    echo "downloaded $f is not valid JS — aborting" >&2
    exit 1
  }
done

printf '%s\n' '{"name":"cc-exec","private":true,"type":"module","dependencies":{"@solana/web3.js":"1.98.4"}}' > package.json
npm install --silent >/dev/null 2>&1

if [ ! -f burner.json ]; then
  echo "▶ generating an unfunded dry-run burner identity…"
  node -e 'const{Keypair}=require("@solana/web3.js");const fs=require("fs");const k=Keypair.generate();fs.writeFileSync("burner.json",JSON.stringify(Array.from(k.secretKey)),{mode:0o600});console.log(k.publicKey.toBase58())' > .pubkey
fi
chmod 600 burner.json
if [ ! -s .pubkey ]; then
  node -e 'const{Keypair}=require("@solana/web3.js");const fs=require("fs");console.log(Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync("burner.json")))).publicKey.toBase58())' > .pubkey
fi
chmod 600 .pubkey
PUBKEY="$(<.pubkey)"

{
  printf 'CC_SECRET=%s\n' "$SECRET"
  printf 'CC_FLOOR=%s\n' "$FLOOR"
  printf 'CC_API=%s\n' "$API"
  printf 'KEYPAIR=%s/burner.json\n' "$INSTALL_DIR"
  printf 'STATE_FILE=%s/.cc-state.json\n' "$INSTALL_DIR"
  printf 'MAX_SOL_PER_TRADE=%s\n' "$MAX_SOL"
  printf 'DAILY_SOL_CAP=%s\n' "$DAILY_CAP"
  printf 'EXECUTE=0\n'
  if [ -n "$RPC" ]; then printf 'SOLANA_RPC=%s\n' "$RPC"; fi
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"
SECRET=""
unset SECRET

SERVICE_FILE="/etc/systemd/system/cc-executor.service"
NODE_BIN="$(command -v node)"
SERVICE_USER="$(id -un)"
echo "▶ writing $SERVICE_FILE (dry-run only)…"
sudo tee "$SERVICE_FILE" >/dev/null <<UNIT
[Unit]
Description=Claude Company dry-run polling executor (floor $FLOOR)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $INSTALL_DIR/poller.mjs
Restart=always
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable cc-executor >/dev/null 2>&1
sudo systemctl restart cc-executor

cat <<DONE

════════════════════════════════════════════════════════════════
  ✓ Dry-run poller installed for floor $FLOOR.

  UNFUNDED DRY-RUN WALLET IDENTITY:
      $PUBKEY

  Watch decisions:  sudo journalctl -u cc-executor -f
  Stop service:      sudo systemctl stop cc-executor

  Secret/config:     $ENV_FILE  (mode 0600)
  Caps evaluated:    max $MAX_SOL SOL/trade, $DAILY_CAP SOL/day

  This release intentionally rejects EXECUTE=1. Do not fund this
  wallet for auto-trading. There is no live activation procedure.
════════════════════════════════════════════════════════════════
DONE
