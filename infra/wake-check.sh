#!/usr/bin/env bash
# Runs every minute on each agent VM. Asks the control plane whether the agent's
# scheduled wake is due; if so, runs one session. A lock prevents overlap.
set -euo pipefail

: "${C67_CONTROL_URL:?}" "${C67_AGENT_ID:?}" "${C67_AGENT_TOKEN:?}"

LOCK=/tmp/c67-session.lock
exec 9>"$LOCK"
flock -n 9 || exit 0   # a session is already running

RESP=$(curl -fsS -H "authorization: Bearer ${C67_AGENT_TOKEN}" \
  "${C67_CONTROL_URL}/agents/${C67_AGENT_ID}/next-wake")

STATUS=$(echo "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",""))')
WAKE=$(echo "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("scheduled_wake") or "")')

# frozen/dead/paused: no sessions. (Final-journal sessions are operator-launched.)
[ "$STATUS" = "alive" ] || exit 0

# No schedule yet = day-0 cold start: wake now.
if [ -n "$WAKE" ]; then
  NOW=$(date -u +%s)
  DUE=$(date -u -d "$WAKE" +%s 2>/dev/null || gdate -u -d "$WAKE" +%s)
  [ "$NOW" -ge "$DUE" ] || exit 0
fi

cd /opt/c67/app/agent-runtime
exec node dist/src/main.js
