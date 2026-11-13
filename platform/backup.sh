#!/usr/bin/env bash
# Daily backup of the app data and environment. Keeps 7 days.
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p backups
chmod 700 backups

stamp="$(date +%F)"
tar -czf "backups/talksketch-${stamp}.tar.gz" .env data 2>/dev/null || true
chmod 600 "backups/talksketch-${stamp}.tar.gz"

find backups -type f -name 'talksketch-*.tar.gz' -mtime +7 -delete

printf '%s backup complete: %s\n' "$(date -Is)" "$(du -h "backups/talksketch-${stamp}.tar.gz" | cut -f1)" >> backups/backup.log
