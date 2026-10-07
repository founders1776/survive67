#!/usr/bin/env bash
# THE kill switch (plan Sec Q5): one command, everything stops, <60s.
# Works from James's laptop over Tailscale. Also available as /kill in Telegram.
# Usage: C67_CONTROL_URL=http://<tailscale-ip>:8067 C67_TOKEN_ADMIN=... ./killswitch.sh "reason"
set -euo pipefail
: "${C67_CONTROL_URL:?}" "${C67_TOKEN_ADMIN:?}"

curl -fsS -X POST "${C67_CONTROL_URL}/admin/killswitch" \
  -H "authorization: Bearer ${C67_TOKEN_ADMIN}" \
  -H "content-type: application/json" \
  -d "{\"reason\": \"${1:-manual kill}\"}"

echo ""
echo "All agents frozen, all tokens revoked."
echo "NOW DO BY HAND: (1) freeze float cards in the bank app;"
echo "(2) if compromise suspected, rotate provider keys in the consoles"
echo "    (fallback if the control plane itself is unreachable: revoke keys"
echo "     at console.anthropic.com / platform.openai.com / aistudio.google.com)."
