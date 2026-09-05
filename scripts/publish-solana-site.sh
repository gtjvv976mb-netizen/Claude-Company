#!/bin/zsh
# Publish the Solana world to solana.claudedotcompany.com.
#
# The site at that domain is BUILT OUTPUT of this repo's viewer/, kept in a separate
# repository because GitHub Pages binds exactly one custom domain per repo and this
# one is bound to the apex. Nothing in that repo is hand-edited; this script is the
# only writer, so the tower can never drift from the desk it describes.
set -u
SRC=~/Downloads/claude-co
SITE=${SOLANA_SITE_DIR:-/tmp/solana-site}
REMOTE=git@github.com:gtjvv976mb-netizen/Claude-Company-Solana.git
DOMAIN=solana.claudedotcompany.com

cd "$SRC" || exit 1
echo "== build =="
npm run build >/dev/null 2>&1 || { echo "build FAILED"; exit 1; }
echo "  dist rebuilt"

if [ ! -d "$SITE/.git" ]; then
  rm -rf "$SITE"; git clone -q "$REMOTE" "$SITE" || exit 1
fi
cd "$SITE" && git pull -q --ff-only 2>/dev/null

echo "== stage =="
# Wipe only the published files, never .git or the README.
find "$SITE" -mindepth 1 -maxdepth 1 ! -name .git ! -name README.md -exec rm -rf {} +
cp -R "$SRC/dist/." "$SITE"/
cd "$SITE"
python3 - <<'PY'
s = open("solana.html", encoding="utf-8").read()
n = s.count('href="index.html"')
# On the apex these meant "back to the gateway"; on this host index.html IS this page,
# so they must be absolute or they become self-links.
s = s.replace('href="index.html"', 'href="https://claudedotcompany.com/"')
open("index.html", "w", encoding="utf-8").write(s)
print(f"  index.html <- solana.html ({n} gateway links repointed)")
PY
echo "$DOMAIN" > CNAME
echo "  CNAME $DOMAIN"

echo "== publish =="
git add -A
if git diff --cached --quiet; then echo "  no change"; exit 0; fi
git -c user.email=brillantesken98@gmail.com -c user.name="Michael Kenneth Brillantes" \
  commit -q -m "Republish the Solana tower from $(cd "$SRC" && git rev-parse --short HEAD)"
git push -q origin main && echo "  pushed"

echo "== verify LIVE =="
for i in {1..20}; do
  code=$(curl -s -m 20 -o /dev/null -w '%{http_code}' "https://$DOMAIN/")
  [ "$code" = "200" ] && { echo "  https://$DOMAIN/ -> 200"; break; }
  [ $i -eq 20 ] && echo "  still $code — if DNS or the certificate is not ready yet this is expected"
  sleep 15
done
