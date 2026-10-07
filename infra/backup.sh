#!/usr/bin/env bash
# Nightly backup (plan Data Q9): ledger + journals + transcripts.
# Always writes a local snapshot to /var/lib/c67/backups; additionally copies
# off-site when rclone remote 'c67backup' is configured (any S3-compatible bucket).
# Also invoked manually BEFORE any harness change (pre-change snapshot rule).
set -euo pipefail

DB="${C67_DB:-/var/lib/c67/data/ledger.db}"
LOCAL=/var/lib/c67/backups
DEST="c67backup:c67/$(hostname)"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Consistent SQLite snapshot (WAL-safe). No sqlite3 CLI on the droplet —
# use the app's own driver so the backup can never drift from what the app reads.
cd /opt/c67/app
node -e "
require('better-sqlite3')(process.env.C67_DB ?? '/var/lib/c67/data/ledger.db', {readonly: true})
  .backup('$TMP/ledger-$STAMP.db')
  .then(() => console.log('snapshot ok'))
  .catch((e) => { console.error(e); process.exit(1); });
"
gzip "$TMP/ledger-$STAMP.db"

# Transcripts/journals directory if present
if [ -d /var/lib/c67/transcripts ]; then
  tar czf "$TMP/transcripts-$STAMP.tgz" -C /var/lib/c67 transcripts
fi

# Local copy first — restore drills and dead-bucket scenarios depend on it.
mkdir -p "$LOCAL"
cp "$TMP"/* "$LOCAL/"
# Local retention: 14 days (off-site keeps the long tail)
find "$LOCAL" -type f -mtime +14 -delete

if command -v rclone >/dev/null && rclone listremotes 2>/dev/null | grep -q '^c67backup:'; then
  rclone copy "$TMP" "$DEST/$STAMP/" --transfers 4
  echo "backup $STAMP done → $LOCAL + $DEST/$STAMP/"
  # Off-site retention: keep 60 days
  rclone delete "$DEST" --min-age 60d || true
else
  echo "backup $STAMP done → $LOCAL (off-site skipped: rclone remote 'c67backup' not configured)"
fi
