#!/usr/bin/env bash
# Issue a pilot access key. Usage: ./issue-key.sh "Client name"
set -euo pipefail
cd "$(dirname "$0")"

name="${1:-client}"
key="ts_$(openssl rand -hex 12)"

if grep -q '^ACCESS_KEYS=' .env; then
  sed -i "s|^ACCESS_KEYS=.*|&,$key|" .env
else
  printf '\nACCESS_KEYS=%s\n' "$key" >> .env
fi

sudo systemctl restart talksketch-demo >/dev/null
printf '%s\n' "$key"
printf 'issued for %s — send this key to the client\n' "$name" >&2
