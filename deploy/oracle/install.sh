#!/usr/bin/env bash
#
# Install the SleePhy relay on a fresh Ubuntu 22.04 / 24.04 server.
#
# Run it from the repository root on the server, as root or with sudo:
#
#   sudo bash deploy/oracle/install.sh
#
# It installs Node.js and Caddy, copies the code to /opt/sleephy, creates the
# service user and the systemd units, and starts both services. It does NOT
# fill in secrets: edit /etc/sleephy/*.env and reload when you are ready.
#
# The script is idempotent — running it again upgrades the code in place and
# restarts the services, leaving the database and the env files alone.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR=/opt/sleephy
STATE_DIR=/var/lib/sleephy
CONF_DIR=/etc/sleephy
NODE_MAJOR=22

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Run me with sudo." >&2
  exit 1
fi

say "Installing Node.js $NODE_MAJOR and Caddy"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg rsync

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi

if ! command -v caddy >/dev/null 2>&1; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -y
  apt-get install -y caddy
fi

say "Creating the service user and directories"
id -u sleephy >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin sleephy
install -d -o sleephy -g sleephy -m 0750 "$APP_DIR" "$STATE_DIR"
install -d -m 0750 "$CONF_DIR"

say "Copying the code to $APP_DIR"
rsync -a --delete \
  --exclude node_modules --exclude .git --exclude '.runtime' \
  --exclude '*.db' --exclude 'dist' --exclude 'deploy/oracle' \
  "$ROOT/" "$APP_DIR/"

say "Installing production dependencies"
( cd "$APP_DIR" && npm ci --omit=dev 2>/dev/null || npm install --omit=dev )

# The download page looks here. It starts empty; drop the installer in later.
install -d -o sleephy -g sleephy -m 0755 "$APP_DIR/dist"

say "Seeding the environment files"
for f in relay pay-adapter; do
  if [ ! -f "$CONF_DIR/$f.env" ]; then
    cp "$ROOT/deploy/oracle/$f.env.example" "$CONF_DIR/$f.env"
    chown root:sleephy "$CONF_DIR/$f.env"
    chmod 0640 "$CONF_DIR/$f.env"
    echo "  wrote $CONF_DIR/$f.env  (fill in the secrets)"
  else
    echo "  kept  $CONF_DIR/$f.env"
  fi
done

say "Installing the systemd units"
install -m 0644 "$ROOT/deploy/oracle/sleephy-relay.service" /etc/systemd/system/
install -m 0644 "$ROOT/deploy/oracle/sleephy-pay-adapter.service" /etc/systemd/system/
chown -R sleephy:sleephy "$APP_DIR"
systemctl daemon-reload
systemctl enable --now sleephy-relay.service sleephy-pay-adapter.service

say "Installing the Caddy site"
if ! grep -q "SleePhy" /etc/caddy/Caddyfile 2>/dev/null; then
  cp "$ROOT/deploy/oracle/Caddyfile" /etc/caddy/Caddyfile
  echo "  wrote /etc/caddy/Caddyfile  (replace relay.example.com with your domain)"
fi
systemctl reload caddy 2>/dev/null || systemctl restart caddy

say "Done"
cat <<'EOF'
Next:
  1. Edit /etc/sleephy/relay.env and /etc/sleephy/pay-adapter.env (secrets, domain).
  2. Put your domain in /etc/caddy/Caddyfile, then: sudo systemctl reload caddy
  3. Restart the services:  sudo systemctl restart sleephy-relay sleephy-pay-adapter
  4. Check:  curl -s http://127.0.0.1:12000/health
             curl -s https://YOUR_DOMAIN/health
  5. In the app, set the server to wss://YOUR_DOMAIN

Open the firewall for web traffic only; the relay and adapter stay on localhost.
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
  sudo netfilter-persistent save
EOF
