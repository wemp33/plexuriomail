# Deploy PlexurioMail to the cloud (not your PC)

You want it always-on, reachable from anywhere, and keeping its data. The app is a small Node server plus one SQLite file, so it needs a host that stays running **and gives it a persistent disk** for that file.

## Most optimal pick

| Host | Cost (small app) | Effort | Why |
|------|------------------|--------|-----|
| **Railway** ⭐ | **~$5/mo** | Easiest dashboard | Cheapest always-on, add a volume in 1 click, deploys straight from GitHub. |
| **Render** | ~$7/mo + disk | One-click from repo | `render.yaml` in this project makes it a true one-click Blueprint. |
| Fly.io / a $4 VPS | ~$4–5/mo | More manual | See `HOSTING.md` for the VPS route. |

**Recommendation: Railway.** It's the cheapest always-on option and the simplest to click through. Render is great if you'd rather it read the included `render.yaml` and set everything up for you.

> Either way, the app itself is the cheap part. Your real cost is the mailboxes (e.g. Google Workspace ~$6/mailbox/mo) — the same with any cold-email tool.

---

## Step 0 — put the code on GitHub (one time)

Both hosts deploy from a GitHub repo. If you've never used GitHub:

1. Create a free account at github.com and click **New repository** → name it `plexuriomail` → Create.
2. On the repo page click **uploading an existing file**, then drag in the **contents** of the unzipped `plexuriomail` folder (all the files and the `src`/`public` folders). Commit.

That's it — no command line needed.

---

## Option A — Railway (recommended, ~$5/mo)

1. Go to **railway.app** → sign in with GitHub → **New Project** → **Deploy from GitHub repo** → pick `plexuriomail`. Railway sees the `Dockerfile` and builds it.
2. Open the service → **Variables** and add:
   - `DB_PATH` = `/data/plexuriomail.db`
   - `DRY_RUN` = `1`  (keep it safe for now; change to `0` when ready to send)
   - `DASH_USER` = `admin`
   - `DASH_PASS` = *(a password you choose — protects your dashboard)*
3. Add storage so your data survives restarts: service → **Settings → Volumes** (or **+ New → Volume**) → mount path **`/data`**.
4. service → **Settings → Networking → Generate Domain**. You'll get a `…up.railway.app` URL.
5. Open the URL, log in with your `DASH_USER` / `DASH_PASS`, and use the app. When you're ready to send real email, change `DRY_RUN` to `0` and it redeploys.

## Option B — Render (one-click Blueprint, ~$7/mo)

1. Do **Step 0** (the repo includes `render.yaml`).
2. Go to **render.com** → **New +** → **Blueprint** → select your `plexuriomail` repo → **Apply**. Render reads `render.yaml` and creates the web service **and** a 1 GB persistent disk at `/data` automatically.
3. In the new service → **Environment**, set **`DASH_PASS`** to a password of your choice. (Leave `DRY_RUN=1` until you're ready, then set `0`.)
4. Open the `…onrender.com` URL, log in, and you're live.

## Option C — cheapest / full control (VPS)

Prefer a $4 server you control? `HOSTING.md` has the full Hetzner/DigitalOcean + Caddy walkthrough.

---

## After it's deployed

- **Go live:** set `DRY_RUN=0` (an env var) and let it redeploy. Until then it simulates — safe to click around.
- **Security:** always set `DASH_PASS` for a public deployment — the dashboard stores mailbox passwords.
- **Custom domain:** optional — both hosts let you attach `mail.yourdomain.com` in their dashboard.
- **Backups:** the whole database is the one file at `/data/plexuriomail.db`; both hosts let you download/snapshot the volume.
