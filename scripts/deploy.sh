#!/usr/bin/env bash
# scripts/deploy.sh - Production deploy on the Hetzner box.
# Called by .github/workflows/deploy.yml over SSH (after it has already run
# `git fetch` + `git reset --hard origin/main`), but safe to run by hand too:
#   cd ~/thirty-one-game && bash scripts/deploy.sh
set -euo pipefail

cd "$(dirname "$0")/.."

CUR=$(git rev-parse --short HEAD)
PREV=$(git rev-parse --short 'HEAD@{1}' 2>/dev/null || echo "none")
echo "== deploying $CUR - $(git log -1 --pretty=%s)"
echo "== previous  $PREV"

# npm install only when the dependency files changed since the previous checkout
CHANGED=$(git diff --name-only 'HEAD@{1}' HEAD 2>/dev/null || true)
if printf '%s\n' "$CHANGED" | grep -qE '^(package\.json|package-lock\.json)$'; then
    echo "== package.json changed: npm install"
    npm install --omit=dev --no-audit --no-fund
else
    echo "== dependencies unchanged"
fi

# Database backup before the restart (never blocks a deploy)
if [ -f data.sqlite ]; then
    node scripts/backup-db.js --tag deploy || echo "!! pre-deploy backup failed (continuing)"
fi

# Nightly backup: (re)install the cron line, tagged so it is replaced, never duplicated.
# 08:17 server time = ~3:17 AM New York when the server clock is UTC.
if command -v crontab >/dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
    BACKUP_DIR="${BACKUP_DIR:-$HOME/blitz31-backups}"
    mkdir -p "$BACKUP_DIR"
    CRON_LINE="17 8 * * * cd $PWD && $NODE_BIN scripts/backup-db.js >> $BACKUP_DIR/backup.log 2>&1 # blitz31-backup"
    OTHER_CRON="$(crontab -l 2>/dev/null | grep -v '# blitz31-backup' || true)"
    { [ -n "$OTHER_CRON" ] && printf '%s\n' "$OTHER_CRON"; echo "$CRON_LINE"; } | crontab - \
        && echo "== nightly backup cron OK" \
        || echo "!! could not install backup cron (continuing)"
else
    echo "!! crontab not found: nightly backup not scheduled"
fi

echo "== restarting pm2 process blitz31"
pm2 restart blitz31 --update-env >/dev/null
sleep 3
pm2 describe blitz31 | grep -E 'status|restarts' || true

# Health check: the server must answer on its port
if curl -sf -o /dev/null --max-time 10 http://127.0.0.1:3000/; then
    echo "== health check OK - deployed $CUR"
else
    echo "!! health check FAILED - last 40 log lines:"
    pm2 logs blitz31 --lines 40 --nostream || true
    exit 1
fi
