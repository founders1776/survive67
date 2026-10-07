#!/usr/bin/env bash
# Deploy the repo to an agent droplet from the local checkout (no git remote yet).
# Usage: deploy-agent-local.sh <ip> <agent-id> <provider> <model>
# Uses secrets/c67_ed25519. Excludes secrets/ and build artifacts from the copy.
set -euo pipefail

IP="${1:?ip}"; AGENT_ID="${2:?agent id}"; PROVIDER="${3:?provider}"; MODEL="${4:?model}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# ssh/rsync -e cannot cope with spaces in the key path ("Agent Case Study"),
# so work from a space-free copy of the key.
KEY="${TMPDIR:-/tmp}/c67_ed25519"
install -m 600 "$REPO_ROOT/secrets/c67_ed25519" "$KEY"

ssh -o BatchMode=yes -i "$KEY" "root@$IP" 'mkdir -p /opt/c67/app'

# Ship only what the VM runs. The agent user can read /opt/c67/app, so anything
# copied here is readable by the agent: control-plane source, the runbooks, the
# operator's notes and the whole git history were all on the box until Tinker
# reported it (bug report #6, 2026-09-21). infra/ is needed for the unit files
# and scripts installed below and is locked to root afterwards.
# --delete-excluded removes anything already on the box that this list no
# longer ships; the two protect rules keep the VM's own build outputs.
rsync -az --delete --delete-excluded \
  --filter 'protect node_modules/' --filter 'protect dist/' \
  --exclude node_modules/ --exclude dist/ --exclude "*.db" \
  --include '/agent-runtime/***' --include '/constitution/***' --include '/infra/***' \
  --include '/package.json' --include '/package-lock.json' --include '/tsconfig.base.json' \
  --include '/control-plane/' --include '/control-plane/package.json' \
  --include '/content/' --include '/content/package.json' \
  --exclude '*' \
  -e "ssh -o BatchMode=yes -i $KEY" \
  "$REPO_ROOT"/ "root@$IP:/opt/c67/app/"

ssh -o BatchMode=yes -i "$KEY" "root@$IP" bash -s -- "$AGENT_ID" "$PROVIDER" "$MODEL" <<'REMOTE'
set -euo pipefail
AGENT_ID="$1"; PROVIDER="$2"; MODEL="$3"

useradd -m -s /bin/bash agent || true
cd /opt/c67/app
npm ci --no-audit --no-fund
npm run build --workspace @c67/agent-runtime
chown -R root:root /opt/c67
# The agent user reads exactly what its runtime loads: the built runtime, the
# constitution, the shared node_modules. Everything else is operator-only.
chmod -R a+rX /opt/c67/app/agent-runtime /opt/c67/app/constitution /opt/c67/app/node_modules
chmod a+rx /opt/c67 /opt/c67/app
chmod -R o-rwx,g-rwx /opt/c67/app/infra /opt/c67/app/control-plane /opt/c67/app/content \
  /opt/c67/app/package.json /opt/c67/app/package-lock.json /opt/c67/app/tsconfig.base.json

# Browser for the agent (playwright + chromium, system deps as root, browser as agent)
npx -y playwright@latest install-deps chromium
sudo -u agent bash -c 'cd ~ && npx -y playwright@latest install chromium'

mkdir -p /etc/c67
if [ ! -f /etc/c67/agent.env ]; then
  cat > /etc/c67/agent.env <<EOF
C67_AGENT_ID=${AGENT_ID}
C67_PROVIDER=${PROVIDER}
C67_MODEL=${MODEL}
C67_CONTROL_URL=
C67_PROXY_URL=
C67_AGENT_TOKEN=
C67_WORKDIR=/home/agent
C67_CONSTITUTION=/opt/c67/app/constitution
C67_CEILING=400000
DISPLAY=:99
EOF
  chmod 600 /etc/c67/agent.env
fi

install -m 644 /opt/c67/app/infra/systemd/c67-wake.service /etc/systemd/system/
install -m 644 /opt/c67/app/infra/systemd/c67-wake.timer /etc/systemd/system/
install -m 755 /opt/c67/app/infra/wake-check.sh /opt/c67/wake-check.sh
# Let the agent's own background work (systemd-run --user, tmux, nohup) outlive
# any session: linger keeps the user manager alive with no login.
loginctl enable-linger agent || true
systemctl daemon-reload
# --now: enable alone only arms the timer for the NEXT boot — it never ticks
# until then (burn-in audit caught all three VMs enabled-but-dead).
systemctl enable --now c67-wake.timer
# Clear any stale root-owned lock so the c67 user's wake-check can take it.
rm -f /tmp/c67-session.lock
# Screen recorder (Xvfb + ffmpeg daemon polling record-state); was hand-installed
# on the burn-in VMs, so a rebuild gets it here.
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq xvfb ffmpeg >/dev/null 2>&1 || true
install -m 755 /opt/c67/app/infra/recorder.sh /opt/c67/recorder.sh
install -m 644 /opt/c67/app/infra/systemd/c67-xvfb.service /etc/systemd/system/
install -m 644 /opt/c67/app/infra/systemd/c67-recorder.service /etc/systemd/system/
mkdir -p /var/lib/c67/recordings
systemctl daemon-reload
systemctl enable --now c67-xvfb c67-recorder || true
echo "deploy done: ${AGENT_ID}"
REMOTE
