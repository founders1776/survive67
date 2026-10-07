#!/usr/bin/env bash
# Ship site/ to the control droplet's Caddy root (static files only; no restart).
# Usage: deploy-site.sh <control ip>
set -euo pipefail
IP="${1:?ip}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEY="${TMPDIR:-/tmp}/c67_ed25519"
install -m 600 "$REPO_ROOT/secrets/c67_ed25519" "$KEY"
node "$REPO_ROOT/infra/build-log.mjs"
rsync -az --delete -e "ssh -o BatchMode=yes -i $KEY" "$REPO_ROOT/site/" "root@$IP:/opt/c67/site/"
echo "site deployed"
