#!/usr/bin/env bash
# Create the Oracle Cloud "Always Free" ARM server, open its ports, bootstrap it (Coolify + hardening)
# and register it with the dashboard. Run it in your own terminal (it opens a browser once to log in):
#
#   bash scripts/oracle-free-vm.sh
#
# Before: sign up at https://www.oracle.com/cloud/free/ (identity + card check; that part can't be scripted).
# Free ARM capacity is often exhausted; the script keeps retrying every RETRY_SECONDS until a slot opens.
# Safe to re-run: it reuses the network and the server if they already exist.
#
# Settings (env vars): OCPUS=4 MEMORY_GB=24 BOOT_GB=200 NAME=hosting-cloud RETRY_SECONDS=90
set -euo pipefail

OCPUS="${OCPUS:-4}"
MEMORY_GB="${MEMORY_GB:-24}"
BOOT_GB="${BOOT_GB:-200}"
NAME="${NAME:-hosting-cloud}"
RETRY_SECONDS="${RETRY_SECONDS:-90}"
SHAPE="VM.Standard.A1.Flex"
PORTS="22 80 443 8000 6001 6002"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
LAPTOP_KEY="${LAPTOP_KEY:-$HOME/.ssh/id_ed25519.pub}"
DASHBOARD_KEY="$HOME/.ssh/hosting_dashboard"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
json() { python3 -c "import json,sys; print(json.dumps($1))"; }

# ---------- prerequisites ----------
say "Checking tools"
command -v python3 >/dev/null || die "python3 is required"
if ! command -v oci >/dev/null; then
  command -v brew >/dev/null || die "install Homebrew first (https://brew.sh) or the OCI CLI manually"
  echo "Installing the Oracle Cloud CLI (brew install oci-cli)…"
  brew install oci-cli
fi
[ -f "$LAPTOP_KEY" ] || die "no SSH key at $LAPTOP_KEY (create one: ssh-keygen -t ed25519)"
[ -f "$DASHBOARD_KEY.pub" ] || ssh-keygen -q -t ed25519 -N "" -C "hosting-dashboard" -f "$DASHBOARD_KEY"

if [ ! -f "$HOME/.oci/config" ]; then
  say "Logging in to Oracle Cloud (a browser window opens; pick your HOME region when asked)"
  oci setup bootstrap
fi
TENANCY=$(awk -F= '/^tenancy/{gsub(/ /,"",$2); print $2; exit}' "$HOME/.oci/config")
REGION=$(awk -F= '/^region/{gsub(/ /,"",$2); print $2; exit}' "$HOME/.oci/config")
[ -n "$TENANCY" ] || die "could not read tenancy from ~/.oci/config"
echo "Tenancy: ${TENANCY:0:30}…  Region: $REGION (Always Free ARM only works in your home region)"
C="--compartment-id $TENANCY"

# ---------- network ----------
say "Network (VCN, internet gateway, firewall rules, public subnet)"
VCN=$(oci network vcn list $C --display-name hosting-vcn --lifecycle-state AVAILABLE --query 'data[0].id' --raw-output 2>/dev/null || true)
if [ -z "$VCN" ] || [ "$VCN" = "None" ]; then
  VCN=$(oci network vcn create $C --display-name hosting-vcn --dns-label hostingvcn \
    --cidr-blocks "$(json '["10.0.0.0/16"]')" --wait-for-state AVAILABLE --query 'data.id' --raw-output)
  echo "created VCN"
fi
IGW=$(oci network internet-gateway list $C --vcn-id "$VCN" --query 'data[0].id' --raw-output 2>/dev/null || true)
if [ -z "$IGW" ] || [ "$IGW" = "None" ]; then
  IGW=$(oci network internet-gateway create $C --vcn-id "$VCN" --is-enabled true --display-name hosting-igw \
    --wait-for-state AVAILABLE --query 'data.id' --raw-output)
fi
RT=$(oci network vcn get --vcn-id "$VCN" --query 'data."default-route-table-id"' --raw-output)
SL=$(oci network vcn get --vcn-id "$VCN" --query 'data."default-security-list-id"' --raw-output)
oci network route-table update --rt-id "$RT" --force \
  --route-rules "$(json "[{'destination':'0.0.0.0/0','destinationType':'CIDR_BLOCK','networkEntityId':'$IGW'}]")" >/dev/null
INGRESS=$(python3 -c "
import json
print(json.dumps([{'protocol':'6','source':'0.0.0.0/0','isStateless':False,'tcpOptions':{'destinationPortRange':{'min':p,'max':p}}} for p in [$(echo $PORTS | tr ' ' ',')]]
  + [{'protocol':'1','source':'0.0.0.0/0','isStateless':False,'icmpOptions':{'type':3,'code':4}}]))")
oci network security-list update --security-list-id "$SL" --force \
  --ingress-security-rules "$INGRESS" \
  --egress-security-rules "$(json "[{'protocol':'all','destination':'0.0.0.0/0','isStateless':False}]")" >/dev/null
echo "open ports: $PORTS"
SUBNET=$(oci network subnet list $C --vcn-id "$VCN" --display-name hosting-subnet --query 'data[0].id' --raw-output 2>/dev/null || true)
if [ -z "$SUBNET" ] || [ "$SUBNET" = "None" ]; then
  SUBNET=$(oci network subnet create $C --vcn-id "$VCN" --display-name hosting-subnet --dns-label hosting \
    --cidr-block 10.0.0.0/24 --route-table-id "$RT" --security-list-ids "$(json "['$SL']")" \
    --wait-for-state AVAILABLE --query 'data.id' --raw-output)
fi

# ---------- server ----------
INSTANCE=$(oci compute instance list $C --display-name "$NAME" --lifecycle-state RUNNING --query 'data[0].id' --raw-output 2>/dev/null || true)
if [ -z "$INSTANCE" ] || [ "$INSTANCE" = "None" ]; then
  say "Finding the latest Ubuntu 24.04 image for ARM"
  IMAGE=$(oci compute image list $C --operating-system "Canonical Ubuntu" --operating-system-version "24.04" \
    --shape "$SHAPE" --sort-by TIMECREATED --sort-order DESC --limit 1 --query 'data[0].id' --raw-output)
  [ -n "$IMAGE" ] && [ "$IMAGE" != "None" ] || die "no Ubuntu 24.04 ARM image found in $REGION"
  ADS=$(oci iam availability-domain list $C --query 'data[].name' --raw-output | python3 -c 'import json,sys; print(" ".join(json.load(sys.stdin)))')

  say "Creating $NAME: $OCPUS OCPU, ${MEMORY_GB} GB RAM, ${BOOT_GB} GB disk (retries every ${RETRY_SECONDS}s if Oracle is out of capacity; Ctrl+C to stop)"
  attempt=0
  while [ -z "$INSTANCE" ] || [ "$INSTANCE" = "None" ]; do
    attempt=$((attempt + 1))
    for AD in $ADS; do
      printf '[%s] attempt %d in %s … ' "$(date +%H:%M:%S)" "$attempt" "$AD"
      if OUT=$(oci compute instance launch $C --availability-domain "$AD" --display-name "$NAME" \
        --shape "$SHAPE" --shape-config "$(json "{'ocpus':$OCPUS,'memoryInGBs':$MEMORY_GB}")" \
        --image-id "$IMAGE" --subnet-id "$SUBNET" --assign-public-ip true \
        --boot-volume-size-in-gbs "$BOOT_GB" --ssh-authorized-keys-file "$LAPTOP_KEY" \
        --wait-for-state RUNNING --query 'data.id' --raw-output 2>&1); then
        INSTANCE=$(printf '%s\n' "$OUT" | grep -o 'ocid1\.instance[^ "]*' | tail -n 1)
        echo "created"
        break
      fi
      if printf '%s' "$OUT" | grep -qi "out of host capacity\|out of capacity"; then
        echo "no capacity"
      elif printf '%s' "$OUT" | grep -qi "LimitExceeded\|QuotaExceeded"; then
        die "over the Always Free limits (an A1 server may already exist, or lower OCPUS / MEMORY_GB / BOOT_GB): $(printf '%s' "$OUT" | grep -o '"message": "[^"]*"' | head -n 1)"
      elif printf '%s' "$OUT" | grep -qi "TooManyRequests"; then
        echo "rate limited, slowing down"
        sleep 60
      else
        echo
        die "launch failed: $(printf '%s' "$OUT" | tail -n 5)"
      fi
    done
    if [ -z "$INSTANCE" ] || [ "$INSTANCE" = "None" ]; then sleep "$RETRY_SECONDS"; fi
  done
else
  say "$NAME already exists, reusing it"
fi

IP=$(oci compute instance list-vnics --instance-id "$INSTANCE" --query 'data[0]."public-ip"' --raw-output)
[ -n "$IP" ] && [ "$IP" != "None" ] || die "the server has no public IP"
echo "Public IP: $IP"

# ---------- bootstrap ----------
say "Waiting for SSH on $IP"
for _ in $(seq 1 60); do
  ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new -o BatchMode=yes "ubuntu@$IP" true 2>/dev/null && break
  sleep 5
done
say "Bootstrapping (updates, hardening, firewall, Coolify): takes about 5 minutes"
scp -o StrictHostKeyChecking=accept-new "$HERE/bootstrap-server.sh" "$DASHBOARD_KEY.pub" "ubuntu@$IP:"
ssh "ubuntu@$IP" "sudo bash bootstrap-server.sh $(basename "$DASHBOARD_KEY.pub")"

# ---------- register with the dashboard ----------
say "Adding it to the dashboard"
touch "$ROOT/servers.txt"
grep -q "^cloud=" "$ROOT/servers.txt" && sed -i '' "s#^cloud=.*#cloud=deploy@$IP:22#" "$ROOT/servers.txt" || echo "cloud=deploy@$IP:22" >> "$ROOT/servers.txt"
(cd "$ROOT" && node scripts/sync-env.mjs >/dev/null)
cat <<EOF

All set.
  Coolify:     http://$IP:8000   ← open it NOW and create the admin account (the first visitor becomes admin)
  SSH:         ssh deploy@$IP
  Dashboard:   locally it's already in .env.local. For Vercel, update these two variables and redeploy:
               VMS                  → run: npm run env:sync -- --print   (copy the VMS line)
               SSH_PRIVATE_KEY_B64  → the value in .env.local
EOF
