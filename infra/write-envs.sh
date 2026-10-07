#!/usr/bin/env bash
# Compose /etc/c67/control.env on the control droplet and fill the agent envs
# on the three agent droplets, all from local secrets/. Never commits secrets.
# Usage: write-envs.sh <control-ip> <claude-ip> <gpt-ip> <gemini-ip>
set -euo pipefail

CONTROL_IP="${1:?control ip}"; CLAUDE_IP="${2:?claude ip}"; GPT_IP="${3:?gpt ip}"; GEMINI_IP="${4:?gemini ip}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEY="${TMPDIR:-/tmp}/c67_ed25519"
install -m 600 "$REPO_ROOT/secrets/c67_ed25519" "$KEY"

source "$REPO_ROOT/secrets/tokens.env"
source "$REPO_ROOT/secrets/stripe-live.env"
source "$REPO_ROOT/secrets/telegram.env"
source "$REPO_ROOT/secrets/mailboxes.env"
source "$REPO_ROOT/secrets/crypto.env"
# Spend-card last-four digits (card watch); not secret, kept with the rest for one source.
[ -f "$REPO_ROOT/secrets/cards.env" ] && source "$REPO_ROOT/secrets/cards.env"
# Discord relay for Reddit leads (webhook lives in the Devvit app's settings, not here).
[ -f "$REPO_ROOT/secrets/discord.env" ] && source "$REPO_ROOT/secrets/discord.env"
# Provider keys land later (consoles not funded yet); empty until then.
C67_ANTHROPIC_KEY="${C67_ANTHROPIC_KEY:-}"
C67_OPENAI_KEY="${C67_OPENAI_KEY:-}"
C67_GOOGLE_KEY="${C67_GOOGLE_KEY:-}"
[ -f "$REPO_ROOT/secrets/providers.env" ] && source "$REPO_ROOT/secrets/providers.env"

ssh -o BatchMode=yes -i "$KEY" "root@$CONTROL_IP" "cat > /etc/c67/control.env <<EOF
C67_PORT=8067
C67_DB=/var/lib/c67/data/ledger.db
C67_TOKEN_CLAUDE=${C67_TOKEN_CLAUDE}
C67_TOKEN_GPT=${C67_TOKEN_GPT}
C67_TOKEN_GEMINI=${C67_TOKEN_GEMINI}
C67_TOKEN_ADMIN=${C67_TOKEN_ADMIN}
C67_TOKEN_REDDIT=${C67_TOKEN_REDDIT:-}
C67_DISCORD_BOT_TOKEN=${C67_DISCORD_BOT_TOKEN:-}
C67_DISCORD_LEADS_CHANNEL=${C67_DISCORD_LEADS_CHANNEL:-}
C67_ANTHROPIC_KEY=${C67_ANTHROPIC_KEY}
C67_OPENAI_KEY=${C67_OPENAI_KEY}
C67_GOOGLE_KEY=${C67_GOOGLE_KEY}
C67_STRIPE_KEY=${C67_STRIPE_KEY}
C67_STRIPE_WEBHOOK_SECRET=${C67_STRIPE_WEBHOOK_SECRET}
C67_BASE_RPC=${C67_BASE_RPC}
C67_ALCHEMY_KEY=${C67_ALCHEMY_KEY:-}
C67_OPERATOR_ADDR=${C67_OPERATOR_ADDR:-}
C67_OPERATOR_KEY=${C67_OPERATOR_KEY:-}
C67_USDC_ADDR_CLAUDE=${C67_USDC_ADDR_CLAUDE}
C67_USDC_KEY_CLAUDE=${C67_USDC_KEY_CLAUDE}
C67_USDC_ADDR_GPT=${C67_USDC_ADDR_GPT}
C67_USDC_KEY_GPT=${C67_USDC_KEY_GPT}
C67_USDC_ADDR_GEMINI=${C67_USDC_ADDR_GEMINI}
C67_USDC_KEY_GEMINI=${C67_USDC_KEY_GEMINI}
C67_SOL_KEY_CLAUDE=${C67_SOL_KEY_CLAUDE:-}
C67_SOL_KEY_GPT=${C67_SOL_KEY_GPT:-}
C67_SOL_KEY_DESK=${C67_SOL_KEY_DESK:-}
C67_SOL_RPC=${C67_SOL_RPC:-}
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
TELEGRAM_CHAT_ID=${TELEGRAM_CHAT_ID}
C67_SMTP_HOST=${C67_SMTP_HOST}
C67_IMAP_HOST=${C67_IMAP_HOST}
C67_MAIL_DOMAIN=survive67.com
C67_MAIL_PASS_CLAUDE=${C67_MAIL_PASS_CLAUDE}
C67_MAIL_PASS_GPT=${C67_MAIL_PASS_GPT}
C67_MAIL_PASS_GEMINI=${C67_MAIL_PASS_GEMINI}
C67_MAIL_PASS_CONTACT=${C67_MAIL_PASS_CONTACT:-}
C67_CARD_LAST4_CLAUDE=${C67_CARD_LAST4_CLAUDE:-}
C67_CARD_LAST4_GPT=${C67_CARD_LAST4_GPT:-}
C67_CARD_LAST4_GEMINI=${C67_CARD_LAST4_GEMINI:-}
C67_MIGADU_ADMIN=${C67_MIGADU_ADMIN:-}
C67_MIGADU_API_KEY=${C67_MIGADU_API_KEY:-}
EOF
chmod 600 /etc/c67/control.env; chown c67:c67 /etc/c67/control.env; echo control.env written"

fill_agent () {
  local ip="$1" token="$2"
  ssh -o BatchMode=yes -i "$KEY" "root@$ip" "
    sed -i 's|^C67_CONTROL_URL=.*|C67_CONTROL_URL=https://api.survive67.com|' /etc/c67/agent.env
    # Bare base URL — the provider adapters append /proxy/<agent> themselves.
    sed -i 's|^C67_PROXY_URL=.*|C67_PROXY_URL=https://api.survive67.com|' /etc/c67/agent.env
    sed -i 's|^C67_AGENT_TOKEN=.*|C67_AGENT_TOKEN=${token}|' /etc/c67/agent.env
    echo agent env filled: \$(hostname)"
}
fill_agent "$CLAUDE_IP" "$C67_TOKEN_CLAUDE"
fill_agent "$GPT_IP" "$C67_TOKEN_GPT"
fill_agent "$GEMINI_IP" "$C67_TOKEN_GEMINI"
