#!/bin/bash
# Retired compatibility entrypoint. The former script rewrote a live environment in
# place without source pinning, versioned cap acknowledgement, readiness validation,
# or rollback. Keeping that path would let old cap bytes regain authority.
set -euo pipefail

cat >&2 <<'EOF'
WALL-ST-E REFUSES: executor/install-live.sh is retired and changed nothing.

For a fresh Linux/systemd installation, use the exact-commit executor/install.sh
workflow documented in executor/README.md. For an existing macOS executor, use the
versioned macos-release.sh + macos-launchagent.sh adoption workflow in that README.

Both supported paths preserve local custody, require two independent RPC providers,
and enforce the current v2 wallet-and-values ceremony for any raised cap profile.
EOF
exit 2
