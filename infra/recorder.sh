#!/usr/bin/env bash
# Screen recorder daemon (plan Ops Q13). Runs on each agent VM.
# Polls the control plane's record-state; while the flag is on, captures the
# Xvfb display with ffmpeg into timestamped segments. Sparing by design:
# nothing is captured unless an event or the operator raises the flag.
set -euo pipefail

: "${C67_CONTROL_URL:?}" "${C67_AGENT_ID:?}" "${C67_AGENT_TOKEN:?}"
DISPLAY_NUM="${C67_REC_DISPLAY:-:99}"
OUT_DIR="${C67_REC_DIR:-/var/lib/c67-rec}"
mkdir -p "$OUT_DIR"

FFMPEG_PID=""

stop_capture() {
  if [ -n "$FFMPEG_PID" ] && kill -0 "$FFMPEG_PID" 2>/dev/null; then
    kill -INT "$FFMPEG_PID" 2>/dev/null || true
    wait "$FFMPEG_PID" 2>/dev/null || true
  fi
  FFMPEG_PID=""
}
trap stop_capture EXIT

while true; do
  STATE=$(curl -fsS -m 10 -H "authorization: Bearer ${C67_AGENT_TOKEN}" \
    "${C67_CONTROL_URL}/agents/${C67_AGENT_ID}/record-state" 2>/dev/null || echo '{}')
  RECORD=$(echo "$STATE" | python3 -c 'import json,sys; print(str(json.load(sys.stdin).get("record", False)).lower())' 2>/dev/null || echo false)

  if [ "$RECORD" = "true" ]; then
    if [ -z "$FFMPEG_PID" ] || ! kill -0 "$FFMPEG_PID" 2>/dev/null; then
      TS=$(date -u +%Y%m%dT%H%M%SZ)
      ffmpeg -nostdin -loglevel error -f x11grab -video_size 1280x800 -framerate 5 \
        -i "$DISPLAY_NUM" -t 660 -c:v libx264 -preset ultrafast -pix_fmt yuv420p \
        "$OUT_DIR/${C67_AGENT_ID}-${TS}.mp4" &
      FFMPEG_PID=$!
    fi
  else
    stop_capture
  fi
  sleep 15
done
