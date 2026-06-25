# Hosting PlexurioMail (cheap, not local, no quality trade-off)

The app itself is tiny — one Node process + a SQLite file — so hosting it costs almost nothing. The real cost of cold email is **domains and mailboxes**, which you'd pay with any tool (Instantly, Smartlead, etc. charge on top of that). This guide gets you a always-on, HTTPS-secured deployment for a few dollars a month.

## What it costs

| Item | Cheapest quality option | Approx cost |
|------|------------------------|-------------|
| Server (VPS) | **Hetzner CX22** (2 vCPU / 4 GB) | **~€3.79/mo** |
|  | or DigitalOcean basic droplet (1 GB) | ~$4–6/mo |
| Sending domain(s) | Namecheap / Cloudflare Registrar | ~$10–12/yr each (~$1/mo) |
| Mailboxes (required) | Google Workspace or Microsoft 365 | ~$6/user/mo each |
| Warmup service (recommended) | Mailreach / Warmup Inbox / Instantly | ~$10–25/mo |
| TLS certificate | Caddy / Let's Encrypt | **free** |

**Bottom line:** the software + server is **~$5/month**. Everything else (mailboxes, warmup) you'd pay with any cold-email product — and a $4 VPS is far cheaper than a $30–100/mo SaaS seat.

> Pricing changes — check current rates: [Hetzner](https://www.hetzner.com/cloud), [DigitalOcean](https://www.digitalocean.com/pricing). (Figures above as of mid-2026.)

---

## Step-by-step

### 1. Buy your sending domain(s)
Buy domains **separate from your main company domain** (see `REPUTATION.md` §1). Namecheap or Cloudflare Registrar are cheap and reliable.

### 2. Create mailboxes + DNS auth
Create 2–3 mailboxes per domain in Google Workspace or Microsoft 365. Set up **SPF, DKIM, DMARC, MX** on each domain (see `REPUTATION.md` §2) and generate an **app password** for each mailbox (you'll paste SMTP + IMAP creds into PlexurioMail).

### 3. Get a server
Create a VPS — **Hetzner CX22** is the best value; a DigitalOcean basic droplet works too. Choose **Ubuntu 24.04**. The smallest plan (1 GB RAM) is plenty.

You'll get an IP and SSH access:
```bash
ssh root@YOUR_SERVER_IP
```

### 4. Install Node + tools
```bash
apt update && apt -y upgrade
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -   # Node 20 LTS
apt -y install nodejs git ufw
# basic firewall: allow SSH + web only
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
```

### 5. Deploy the app
Upload the project (scp the folder, or `git clone` your repo), then:
```bash
cd /opt && unzip ~/plexuriomail.zip -d /opt   # or git clone
cd /opt/plexuriomail
npm install --omit=dev
cp .env.example .env
nano .env
```
In `.env` set:
```
DRY_RUN=0
PORT=3000
```
Test once: `npm start` → you should see "PlexurioMail running" and "Mode: LIVE". Ctrl-C.

### 6. Keep it running (systemd)
Create `/etc/systemd/system/plexuriomail.service`:
```ini
[Unit]
Description=PlexurioMail
After=network.target

[Service]
WorkingDirectory=/opt/plexuriomail
ExecStart=/usr/bin/node src/server.js
Restart=always
EnvironmentFile=/opt/plexuriomail/.env
User=www-data

[Install]
WantedBy=multi-user.target
```
```bash
chown -R www-data:www-data /opt/plexuriomail
systemctl enable --now plexuriomail
systemctl status plexuriomail        # should be "active (running)"
```

### 7. HTTPS + a real domain (Caddy = free auto-TLS)
Point a subdomain (e.g. `mail.yourdomain.com`) at the server's IP (an A record). Then:
```bash
apt -y install caddy
nano /etc/caddy/Caddyfile
```
```
mail.yourdomain.com {
    encode gzip
    reverse_proxy 127.0.0.1:3000
    basic_auth {
        # generate a hash: caddy hash-password
        admin <PASTE_BCRYPT_HASH>
    }
}
```
```bash
systemctl reload caddy
```
Caddy fetches a free Let's Encrypt cert automatically. HTTPS secures the dashboard, and the `basic_auth` block keeps the public internet out of it — **don't skip it.**

### 8. Backups
Everything lives in one SQLite file. Back it up daily:
```bash
# crontab -e
0 3 * * * cp /opt/plexuriomail/data/plexuriomail.db /opt/backups/plexuriomail-$(date +\%F).db
```
For off-box backups, sync `/opt/backups` to cheap object storage (Backblaze B2, S3) with `rclone`.

### 9. Go live
Open `https://mail.yourdomain.com`, add your mailboxes (SMTP **and** IMAP), let warmup run for 2+ weeks, import a **verified** list, and start a campaign. The badge should read **Live**.

---

## Even cheaper / alternatives
- **One $4 droplet** can host this plus a few side projects — it's that light.
- **PaaS (Fly.io, Render):** possible and simple, but you must mount a persistent volume for the SQLite file, and it usually costs more than a $4 VPS for an always-on service. A VPS is the cheapest steady option.
- **Don't run it on your laptop** for real sending — it needs to be online 24/7 to pace sends, scan IMAP, and serve unsubscribe links.

## Security checklist
- Dashboard behind `basic_auth` (or a VPN) — it holds mailbox passwords.
- Firewall on (only 22/80/443 open).
- Keep `DRY_RUN=0` only on the server; never commit `.env`.
- Use app passwords, not primary mailbox passwords.
