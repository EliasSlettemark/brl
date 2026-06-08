# BRL HubSpot sync

Scrapes regnskapstall/1881 and syncs to HubSpot list 395.

## Server setup

```bash
git clone https://github.com/EliasSlettemark/brl.git /opt/brl
cd /opt/brl
nano .env   # HUBSPOT_ACCESS_TOKEN, CHROME_EXECUTABLE_PATH after install-chrome
bash scripts/setup-server.sh
```

## Commands

```bash
pm2 logs brl-sync      # live logs
pm2 status
pm2 restart brl-sync
cat progress.json      # resume index
```

Progress saves after each company. PM2 restarts on crash and resumes from `progress.json`.

Reset from start: `RESET_PROGRESS=1 pm2 restart brl-sync`

Test batch: `LIMIT=3 node --env-file=.env sync-hubspot.js`
