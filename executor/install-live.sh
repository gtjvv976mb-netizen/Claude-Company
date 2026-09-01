#!/bin/bash
# Arms WALL-ST-E for LIVE trading. Every input is prompted with hidden typing —
# nothing echoes, nothing enters shell history, nothing leaves this Mac.
# The poller re-validates all of this again at startup; this script mirrors those
# gates so you find a problem now, not at 3am.
cd "$(dirname "$0")" || exit 1

BURNER_PUB=$(node -e "
const {Keypair}=require('@solana/web3.js');
const fs=require('fs');
const kp=Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync('burner.json','utf8'))));
console.log(kp.publicKey.toBase58());" 2>/dev/null)
if [ -z "$BURNER_PUB" ]; then echo "Could not read burner.json — aborting."; exit 1; fi

echo ""
echo "════════════════════════════════════════════════════════════════════"
echo "  GOING LIVE. Real SOL will trade, hard-capped at:"
echo "     0.005 SOL per trade · 0.01 SOL per day · 0.01 SOL daily loss"
echo "  The burner wallet is the entire blast radius."
echo "════════════════════════════════════════════════════════════════════"
echo ""

printf "Jupiter API key (hidden): "; read -rs JUPKEY; echo
printf "Primary RPC URL (hidden): "; read -rs RPC1; echo
printf "Secondary RPC URL — DIFFERENT provider (hidden): "; read -rs RPC2; echo
# Export BEFORE validation — the validator reads the environment, and the first
# version exported after it, so every input validated as an empty string.
export JUPKEY RPC1 RPC2

python3 - <<PYEOF
import sys, os, io, re
from urllib.parse import urlparse
jup = os.environ.get("JUPKEY", "").strip()
rpc1 = os.environ.get("RPC1", "").strip()
rpc2 = os.environ.get("RPC2", "").strip()
def die(m): sys.exit("REFUSED: " + m + " — nothing was changed.")
if len(jup) < 10: die("that Jupiter key looks too short")
for name, u in [("primary RPC", rpc1), ("secondary RPC", rpc2)]:
    p = urlparse(u)
    if p.scheme != "https": die(name + " must be an https:// URL")
    if p.hostname == "api.mainnet-beta.solana.com": die(name + " is the rate-limited public RPC")
h1, h2 = urlparse(rpc1).hostname, urlparse(rpc2).hostname
if h1 == h2: die("both RPCs are on " + h1 + " — they must be independent providers")
PYEOF
[ $? -ne 0 ] && exit 1

echo ""
echo "The deliberate acknowledgement. This burner's PUBLIC key is:"
echo ""
echo "    $BURNER_PUB"
echo ""
printf "Retype (or paste) it exactly to confirm you intend live trading: "
read -r ACK
if [ "$ACK" != "$BURNER_PUB" ]; then
  echo "Acknowledgement does not match — nothing was changed."
  unset JUPKEY RPC1 RPC2
  exit 1
fi

JUPKEY="$JUPKEY" RPC1="$RPC1" RPC2="$RPC2" ACK="$ACK" python3 - <<'PYEOF'
import os, io, re
p = ".cc-executor.env"
s = io.open(p).read()
def setline(s, key, val):
    if re.search(r"^" + key + "=", s, flags=re.M):
        return re.sub(r"^" + key + "=.*$", key + "=" + val, s, count=1, flags=re.M)
    return s.rstrip("\n") + "\n" + key + "=" + val + "\n"
s = setline(s, "EXECUTE", "1")
s = setline(s, "JUPITER_API_KEY", os.environ["JUPKEY"].strip())
s = setline(s, "SOLANA_RPC", os.environ["RPC1"].strip())
s = setline(s, "SOLANA_RPC_SECONDARY", os.environ["RPC2"].strip())
s = setline(s, "LIVE_TRADING_ACK", os.environ["ACK"].strip())
io.open(p, "w").write(s)
os.chmod(p, 0o600)
os.chmod("burner.json", 0o600)
print("")
print("LIVE configuration installed and locked to 600.")
print("Fund the burner LAST, from Phantom, only with what you can lose:")
print("    send ~0.06 SOL to " + os.environ["ACK"].strip())
print("Then tell Claude: go live")
PYEOF
unset JUPKEY RPC1 RPC2 ACK
