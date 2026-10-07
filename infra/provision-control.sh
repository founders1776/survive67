#!/usr/bin/env bash
# Control-plane VM (the 4th machine). Run AFTER provision-base.sh, as root.
# Deploys the repo, installs the service, prepares data + backup dirs.
# Secrets: fill /etc/c67/control.env by hand (template below) — never in the repo.
set -euo pipefail

REPO_URL="${1:?usage: provision-control.sh <repo-url-or-path>}"

useradd -m -s /bin/bash c67 || true
mkdir -p /opt/c67 /var/lib/c67/data /var/lib/c67/backups /etc/c67
chown -R c67:c67 /opt/c67 /var/lib/c67

sudo -u c67 git clone "$REPO_URL" /opt/c67/app || (cd /opt/c67/app && sudo -u c67 git pull)
cd /opt/c67/app
sudo -u c67 npm ci
sudo -u c67 npm run build --workspace @c67/control-plane

if [ ! -f /etc/c67/control.env ]; then
  cat > /etc/c67/control.env <<'EOF'
# ---- fill by hand; chmod 600 ----
C67_PORT=8067
C67_DB=/var/lib/c67/data/ledger.db
C67_TOKEN_CLAUDE=
C67_TOKEN_GPT=
C67_TOKEN_GEMINI=
C67_TOKEN_ADMIN=
C67_ANTHROPIC_KEY=
C67_OPENAI_KEY=
C67_GOOGLE_KEY=
C67_STRIPE_KEY=
C67_STRIPE_WEBHOOK_SECRET=
C67_BASE_RPC=
C67_USDC_ADDR_CLAUDE=
C67_USDC_KEY_CLAUDE=
C67_USDC_ADDR_GPT=
C67_USDC_KEY_GPT=
C67_USDC_ADDR_GEMINI=
C67_USDC_KEY_GEMINI=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
EOF
  chmod 600 /etc/c67/control.env
  echo ">>> EDIT /etc/c67/control.env before starting the service"
fi

install -m 644 infra/systemd/c67-control.service /etc/systemd/system/
install -m 644 infra/systemd/c67-backup.service /etc/systemd/system/
install -m 644 infra/systemd/c67-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable c67-control c67-backup.timer

echo "control plane provisioned. Fill /etc/c67/control.env, then: systemctl start c67-control"
