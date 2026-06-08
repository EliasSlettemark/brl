#!/bin/bash
set -euo pipefail

apt-get update
apt-get install -y git ca-certificates curl

if ! command -v node >/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

npm install -g pm2
apt-get install -y \
  libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libc6 libcairo2 libcups2t64 \
  libdbus-1-3 libexpat1 libfontconfig1 libgbm1 libgcc-s1 libglib2.0-0t64 \
  libgtk-3-0t64 libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 \
  libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
  libxkbcommon0 libxrandr2 wget xdg-utils

cd /opt/brl
npm install
npm run install-chrome

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Edit /opt/brl/.env then: pm2 start ecosystem.config.cjs && pm2 save"
  exit 0
fi

pm2 delete brl-sync 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup systemd -u root --hp /root

echo "Running. Logs: pm2 logs brl-sync"
