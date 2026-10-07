#!/usr/bin/env bash
# Deploy the control plane to the control droplet from the local checkout.
# Usage: deploy-control-local.sh <ip>
# Rsyncs the repo (secrets excluded), builds, installs systemd units and Caddy.
# /etc/c67/control.env is written separately (write-control-env.sh) — never by rsync.
set -euo pipefail

IP="${1:?ip}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEY="${TMPDIR:-/tmp}/c67_ed25519"
install -m 600 "$REPO_ROOT/secrets/c67_ed25519" "$KEY"

ssh -o BatchMode=yes -i "$KEY" "root@$IP" 'mkdir -p /opt/c67/app'

rsync -az --delete \
  --exclude secrets/ --exclude node_modules/ --exclude .ultraplan/ \
  --exclude "*.db" --exclude dist/ \
  -e "ssh -o BatchMode=yes -i $KEY" \
  "$REPO_ROOT"/ "root@$IP:/opt/c67/app/"

ssh -o BatchMode=yes -i "$KEY" "root@$IP" bash -s <<'REMOTE'
set -euo pipefail

useradd -m -s /bin/bash c67 || true
mkdir -p /var/lib/c67/data /var/lib/c67/backups /etc/c67
chown -R c67:c67 /var/lib/c67

cd /opt/c67/app
npm ci --no-audit --no-fund
npm run build --workspace @c67/control-plane
chown -R c67:c67 /opt/c67/app

install -m 644 infra/systemd/c67-control.service /etc/systemd/system/
install -m 644 infra/systemd/c67-backup.service /etc/systemd/system/
install -m 644 infra/systemd/c67-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable c67-control c67-backup.timer
systemctl restart c67-control

# Caddy: TLS for api.survive67.com (agents, Stripe webhook) and survive67.com
# (the public site). The site calls the control plane SAME-ORIGIN through
# survive67.com/api/* so the admin key never crosses origins and no CORS is
# needed for OPS. Stripped prefix: /api/public/state -> :8067/public/state.
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq caddy rsync
cat > /etc/caddy/Caddyfile <<'CADDY'
api.survive67.com {
	reverse_proxy 127.0.0.1:8067 {
		header_up X-Forwarded-For {remote_host}
	}
}

survive67.com {
	encode gzip
	handle_path /api/* {
		reverse_proxy 127.0.0.1:8067 {
			# overwrite, never append: the app rate-limits and locks out by this value
			header_up X-Forwarded-For {remote_host}
		}
	}
	handle {
		root * /opt/c67/site
		header /seasons/* Cache-Control "public, max-age=3600"
		# the app itself always revalidates (ETag) so a deploy is visible on the next load
		@app path *.html *.js *.css /
		header @app Cache-Control "no-cache"
		file_server
	}
}

www.survive67.com {
	redir https://survive67.com{uri} permanent
}
CADDY
mkdir -p /opt/c67/site
# --delete: the old story site is gone once this ships; seasons/ lives in the repo too.
rsync -a --delete /opt/c67/app/site/ /opt/c67/site/
systemctl enable caddy
systemctl restart caddy

# Firewall: web + ssh only; port 8067 stays loopback/tailnet
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
echo "control deploy done: $(hostname)"
REMOTE
