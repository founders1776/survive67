#!/usr/bin/env bash
# Does a candidate model accept this world's constitution, or refuse it?
#
# Run this BEFORE any lineup change. Fable 5 was chosen for the claude lane and
# had to be replaced at rehearsal because its safety layer refused the
# constitution in ~80% of calls - the lane was unplayable and we found out by
# watching sessions die. This is that measurement, as a command.
#
# Sends the REAL system prompt (constitution + inventory + price tables, joined
# exactly as agent-runtime/src/main.ts joins them) plus a realistic first-wake
# user turn, N times, and counts stop_reason=refusal.
#
# A known refuser is included automatically as a control. A clean result from a
# test that cannot fail means nothing, so if the control does not refuse, this
# script tells you its own result is void.
#
# Usage:  bash infra/model-refusal-check.sh <control-ip> [trials] [model ...]
#         bash infra/model-refusal-check.sh <control-ip> 20 claude-opus-5-5
#
# Costs real money from the lane's prepaid provider pool, and bypasses the
# proxy, so it does NOT appear in the ledger. ~$0.02 per trial after caching.
set -euo pipefail
IP="${1:?control ip}"; TRIALS="${2:-20}"
# shift past ip and trials only when both were given; otherwise "$@" would still
# hold the ip and the script would try to refusal-test an IP address as a model.
if [ $# -ge 2 ]; then shift 2; else shift; fi
MODELS=("$@"); [ ${#MODELS[@]} -eq 0 ] && MODELS=("claude-opus-5-5")
CONTROL="claude-fable-5"   # known to refuse this prompt; the self-test
KEY="${TMPDIR:-/tmp}/c67_ed25519"
install -m 600 "$(cd "$(dirname "$0")/.." && pwd)/secrets/c67_ed25519" "$KEY"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# The tool list the real wake sends, from the built runtime, so the probe measures
# the same prompt the agent gets (a bare prompt is a different question).
TOOLS="${TMPDIR:-/tmp}/c67_refusal_tools.json"
(cd "$ROOT/agent-runtime" && npm run -s build >/dev/null && node -e 'import("./dist/src/session.js").then(m=>process.stdout.write(JSON.stringify(m.toolDefs(false))))' > "$TOOLS")
scp -q -o BatchMode=yes -i "$KEY" "$(dirname "$0")/refusal-probe.mjs" "root@$IP:/tmp/refusal-probe.mjs"
scp -q -o BatchMode=yes -i "$KEY" "$TOOLS" "root@$IP:/tmp/refusal-tools.json"
for m in "${MODELS[@]}" "$CONTROL"; do
  [ "$m" = "$CONTROL" ] && echo "--- CONTROL (must refuse, or this run is void) ---"
  ssh -o BatchMode=yes -i "$KEY" "root@$IP" "MODEL=$m TRIALS=$TRIALS TOOLS_JSON=/tmp/refusal-tools.json node /tmp/refusal-probe.mjs"
done
ssh -o BatchMode=yes -i "$KEY" "root@$IP" "rm -f /tmp/refusal-probe.mjs /tmp/refusal-tools.json"
rm -f "$TOOLS"
