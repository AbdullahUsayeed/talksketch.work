#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

set_kv() {
  local k="$1" v="$2"
  if grep -q "^${k}=" .env; then
    sed -i "s|^${k}=.*|${k}=${v}|" .env
  else
    printf '\n%s=%s\n' "$k" "$v" >> .env
  fi
}

set_kv GOOGLE_CLIENT_ID '833770409030-bqipvfdamrkurjv6bthuso2e5f569ect.apps.googleusercontent.com'
set_kv ALLOWED_EMAILS 'usayeed10@gmail.com'
set_kv SESSION_SECRET "$(openssl rand -hex 32)"

sudo systemctl restart talksketch-demo
sleep 2
curl -s https://54.255.181.218.sslip.io/v1/config
