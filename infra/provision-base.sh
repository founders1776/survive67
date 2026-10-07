#!/usr/bin/env bash
# Base hardening for every VM (control + agents). Run as root on fresh Ubuntu 24.04.
# Usage: ./provision-base.sh <hostname>
set -euo pipefail

HOSTNAME_ARG="${1:?usage: provision-base.sh <hostname>}"
hostnamectl set-hostname "$HOSTNAME_ARG"

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  fail2ban unattended-upgrades curl git build-essential python3 sqlite3 tmux

# SSH: keys only (plan Sec Q17)
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
systemctl restart ssh

# Auto security updates
dpkg-reconfigure -f noninteractive unattended-upgrades

# fail2ban defaults are fine for sshd
systemctl enable --now fail2ban

# Tailscale (admin surface is Tailscale-only, plan Sec Q11)
curl -fsSL https://tailscale.com/install.sh | sh
echo ">>> run: tailscale up --ssh   (authenticate in browser once)"

# Node 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

echo "base provisioning done for $HOSTNAME_ARG"
