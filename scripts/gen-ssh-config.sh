#!/usr/bin/env bash
# Turn tokens.txt (one InstaBox SSH username per line) into ssh aliases box1..boxN.
# Writes ~/.ssh/config.d/instabox and makes ~/.ssh/config include it.
# Re-run any time you add or remove a box.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
tokens="${1:-$here/../tokens.txt}"
out="$HOME/.ssh/config.d/instabox"
cfg="$HOME/.ssh/config"

[ -f "$tokens" ] || { echo "No tokens file at $tokens"; exit 1; }
mkdir -p "$HOME/.ssh/config.d" && chmod 700 "$HOME/.ssh/config.d"

tmp="$(mktemp)"
n=0
while IFS= read -r line || [ -n "$line" ]; do
  [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
  # Accept a bare token, user@host, or a pasted ssh command: pull out the ibssh_ token.
  tok="$(grep -oE 'ibssh_[A-Za-z0-9_-]+' <<<"$line" | head -1 || true)"
  if [ -z "$tok" ]; then echo "Skipping line without an ibssh_ token: $line" >&2; continue; fi
  n=$((n + 1))
  cat >>"$tmp" <<EOF
Host box$n
    HostName ssh.instabox.sh
    Port 2222
    User $tok
    StrictHostKeyChecking no
    UserKnownHostsFile /dev/null
    LogLevel ERROR
    ServerAliveInterval 30
    ServerAliveCountMax 3

EOF
done <"$tokens"

if [ "$n" -eq 0 ]; then rm -f "$tmp"; echo "No tokens found in $tokens"; exit 1; fi
mv "$tmp" "$out" && chmod 600 "$out"

# Include must sit above any Host block, so prepend it once.
touch "$cfg"
if ! grep -qE '^Include +(~/\.ssh/)?config\.d/\*' "$cfg"; then
  cp "$cfg" "$cfg.bak-before-instabox"
  { echo "Include config.d/*"; echo; cat "$cfg"; } >"$cfg.tmp" && mv "$cfg.tmp" "$cfg"
  echo "Added 'Include config.d/*' to $cfg (backup: $cfg.bak-before-instabox)"
fi

echo "Wrote $n aliases (box1..box$n) to $out"
