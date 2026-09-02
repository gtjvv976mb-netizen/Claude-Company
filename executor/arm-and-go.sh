#!/bin/bash
# ONE interactive command for the Mac: unload -> arm caps (you type the sentence) -> load,
# then two explicit yes/no decisions: lift the entry pause, and sell back the probe's BONK.
# Nothing here authors an acknowledgement or moves money without you answering a prompt.
set -euo pipefail
if [ "$(uname)" != "Darwin" ]; then
  echo "This runs on the Mac where WALL-ST-E is installed (Terminal.app), not on a server." >&2; exit 1
fi
cd "$(dirname "$0")"
R="$HOME/Library/Application Support/ClaudeCompany/releases/b5afd8fa113a06d43c2117901b179a01bb70ca98/executor"
ENVF="$PWD/.cc-executor.env"
[ -d "$R" ] || { echo "release not found: $R" >&2; exit 1; }
[ -f "$ENVF" ] || { echo "env not found: $ENVF" >&2; exit 1; }

echo "== power =="; pmset -g ps | head -1
if pmset -g ps | head -1 | grep -q Battery; then
  echo "!! Mac is on BATTERY. The watchdog pauses entries on battery. Plug in AC, then re-run." >&2; exit 1
fi

echo; echo "== 1/3 unload the running agent =="
bash macos-launchagent.sh unload --executor-dir "$R" --env-file "$ENVF" || echo "(agent was not loaded — continuing)"
for i in $(seq 1 20); do pgrep -f launchd-runner >/dev/null || break; sleep 1; done

echo; echo "== 2/3 arm caps: 0.05 SOL/trade, 0.5/day, 0.15 daily-loss brake =="
echo "   It will print a sentence. Type it back EXACTLY, then press Return."
bash macos-launchagent.sh arm-caps --executor-dir "$R" --env-file "$ENVF" \
  --max-sol 0.05 --daily-sol-cap 0.5 --daily-loss-cap 0.15

echo; echo "== 3/3 load the agent =="
bash macos-launchagent.sh load --executor-dir "$R" --env-file "$ENVF"
sleep 6; tail -4 "$HOME/Library/Logs/ClaudeCompany/wallste.stdout.log" | cut -c1-140

echo; read -r -p "Lift the entry pause so the bot may open positions? [y/N] " a
if [ "${a:-N}" = "y" ] || [ "${a:-N}" = "Y" ]; then
  rm -f .cc-executor.sqlite.pause-entries && echo "   entry pause lifted"
else echo "   pause left in place"; fi

echo; read -r -p "Sell the probe's BONK back to SOL now (real money, ~\$5)? [y/N] " b
if [ "${b:-N}" = "y" ] || [ "${b:-N}" = "Y" ]; then
  set -a; source "$ENVF"; set +a
  TEST_MINT=DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 node close-out.mjs 2>&1 | grep -E "CLOSEOUT|Error:" | tail -8
else echo "   BONK left in the burner"; fi
echo; echo "Done. Live log: tail -f ~/Library/Logs/ClaudeCompany/wallste.stdout.log"
