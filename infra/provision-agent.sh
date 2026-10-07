#!/usr/bin/env bash
# Agent VM (one per agent). Run AFTER provision-base.sh, as root.
# Usage: provision-agent.sh <repo-url> <agent-id: claude|gpt|gemini> <provider> <model>
set -euo pipefail

REPO_URL="${1:?repo url}"
AGENT_ID="${2:?agent id}"
PROVIDER="${3:?provider}"
MODEL="${4:?model}"

# The agent lives as user 'agent' with full ownership of its home (constitution §1).
useradd -m -s /bin/bash agent || true
# The constitution promises a ROOT VPS with openable inbound ports, and the
# proxy design assumes the VM is fully tamperable (nothing secret lives here).
# Without this the agent could not open a single port: every site it built
# was unreachable and its business plans were fiction (burn-in, 2026-09-20).
echo "agent ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/90-c67-agent
chmod 440 /etc/sudoers.d/90-c67-agent

# Firewall baseline (Day 0, constitution Appendix A / inventory): SSH, the
# tailnet, and the common web ports open inbound; the agent owns ufw beyond
# that. The burn-in VMs had a hand-applied 22+tailnet-only wall and Loom's
# site was unreachable for two days. Idempotent; a rebuild gets exactly this.
apt-get install -y -qq ufw >/dev/null
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp >/dev/null
ufw allow in on tailscale0 >/dev/null || true
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 8080/tcp >/dev/null
ufw --force enable >/dev/null
ufw status | head -12

# Harness lives outside the agent's write reach; the agent may read the constitution.
mkdir -p /opt/c67 /etc/c67
# "local": the code arrives by rsync (deploy-agent-local.sh) instead of a clone.
if [ "$REPO_URL" != "local" ]; then
  git clone "$REPO_URL" /opt/c67/app || (cd /opt/c67/app && git pull)
  cd /opt/c67/app
  npm ci
  npm run build --workspace @c67/agent-runtime
  chown -R root:root /opt/c67
  chmod -R a+rX /opt/c67
fi

# Browser for the agent to drive via shell (playwright + chromium)
sudo -u agent bash -c 'cd ~ && npx -y playwright@latest install chromium --with-deps' || \
  npx -y playwright@latest install-deps chromium

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
EOF
  chmod 600 /etc/c67/agent.env
  echo ">>> EDIT /etc/c67/agent.env (control url + token)"
fi

install -m 644 infra/systemd/c67-wake.service /etc/systemd/system/
install -m 644 infra/systemd/c67-wake.timer /etc/systemd/system/
install -m 755 infra/wake-check.sh /opt/c67/wake-check.sh
systemctl daemon-reload
systemctl enable c67-wake.timer

echo "agent VM provisioned for ${AGENT_ID}. Fill /etc/c67/agent.env, then: systemctl start c67-wake.timer"
