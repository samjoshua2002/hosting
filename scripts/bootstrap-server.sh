#!/usr/bin/env bash
# Turn a fresh Ubuntu/Debian VPS into an always-on host for this dashboard + Coolify.
#
#   scp scripts/bootstrap-server.sh ~/.ssh/hosting_dashboard.pub ubuntu@<ip>:
#   ssh ubuntu@<ip> 'sudo bash bootstrap-server.sh hosting_dashboard.pub'
#
# What it does (safe to re-run):
#   1. security updates now + automatic security updates later
#   2. a "deploy" user the dashboard logs in as (key only, sudo, docker, lingering systemd --user)
#   3. SSH: no passwords, no root login
#   4. firewall: only 22, 80, 443 and Coolify's 8000/6001/6002
#   5. fail2ban against SSH brute force
#   6. Coolify (self-hosted PaaS: apps from git, one-click Postgres/MySQL/MongoDB/Redis, backups, HTTPS)
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
PUBKEY_FILE="${1:-}"
[ -n "$PUBKEY_FILE" ] && [ -s "$PUBKEY_FILE" ] || { echo "usage: sudo bash $0 <dashboard-public-key-file>"; exit 1; }
grep -qE '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-)' "$PUBKEY_FILE" || { echo "$PUBKEY_FILE is not an SSH public key"; exit 1; }

export DEBIAN_FRONTEND=noninteractive
PORTS="22 80 443 8000 6001 6002"

echo "==> 1/6 updates"
apt-get update -qq
apt-get -y -qq upgrade
apt-get -y -qq install curl ca-certificates git fail2ban unattended-upgrades >/dev/null
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true

echo "==> 2/6 deploy user"
id deploy >/dev/null 2>&1 || useradd -m -s /bin/bash deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
touch /home/deploy/.ssh/authorized_keys
grep -qxF "$(cat "$PUBKEY_FILE")" /home/deploy/.ssh/authorized_keys || cat "$PUBKEY_FILE" >> /home/deploy/.ssh/authorized_keys
# also let in whoever ran this script (your laptop key), so you can always reach the server
for f in /home/"${SUDO_USER:-ubuntu}"/.ssh/authorized_keys /root/.ssh/authorized_keys; do
  [ -f "$f" ] && while read -r k; do [ -n "$k" ] && { grep -qxF "$k" /home/deploy/.ssh/authorized_keys || echo "$k" >> /home/deploy/.ssh/authorized_keys; }; done < "$f"
done
chown deploy:deploy /home/deploy/.ssh/authorized_keys && chmod 600 /home/deploy/.ssh/authorized_keys
echo "deploy ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/90-deploy && chmod 440 /etc/sudoers.d/90-deploy
loginctl enable-linger deploy   # the dashboard runs projects as systemd --user services

echo "==> 3/6 ssh hardening"
cat > /etc/ssh/sshd_config.d/90-hardening.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
sshd -t && (systemctl reload ssh 2>/dev/null || systemctl reload sshd)

echo "==> 4/6 firewall"
if command -v netfilter-persistent >/dev/null 2>&1 && [ -f /etc/iptables/rules.v4 ]; then
  # Oracle Cloud images ship iptables rules that reject everything but SSH; open our ports above the REJECT
  for p in $PORTS; do
    iptables -C INPUT -p tcp --dport "$p" -m state --state NEW -j ACCEPT 2>/dev/null ||
      iptables -I INPUT 5 -p tcp --dport "$p" -m state --state NEW -j ACCEPT
  done
  netfilter-persistent save >/dev/null
else
  apt-get -y -qq install ufw >/dev/null
  for p in $PORTS; do ufw allow "$p"/tcp >/dev/null; done
  ufw --force enable >/dev/null
fi

echo "==> 5/6 fail2ban"
systemctl enable --now fail2ban >/dev/null 2>&1 || true

echo "==> 6/6 Coolify (installs Docker too)"
if [ ! -d /data/coolify ]; then
  curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash
fi
usermod -aG docker deploy

IP=$(curl -fsS -4 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
cat <<EOF

Done.
  Coolify:   http://$IP:8000   (create the admin account right away, then give it a domain + HTTPS)
  Dashboard: add  cloud=deploy@$IP:22  to VMS, and SSH_PRIVATE_KEY_B64 in Vercel, then redeploy.
EOF
