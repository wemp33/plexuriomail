# PlexurioMail

Self-hosted cold-email platform with an Instantly-style dashboard. Add mailboxes (SMTP + IMAP), warm them up, build multi-step campaigns with A/B variants, schedule by timezone, and read every reply in one unified inbox — with an intelligent backend that protects deliverability.

One Node process: Express API + web dashboard + SQLite.

> **By design:** no open tracking and no unsubscribe links are added to your emails.

## Do you need IMAP? Yes.

SMTP only sends. PlexurioMail uses IMAP to detect **replies** (stop the sequence + show them in the unified inbox) and process **async bounces** (suppress the lead + feed the bounce guardrail). Add IMAP credentials per mailbox.

## The app

- **Mailboxes** — add a mailbox; each is listed with a 🔥 **fire toggle** (click to warm it up — turns orange), a **health score**, **warmup emails sent today**, and **real emails sent today**.
- **Campaigns** — a list marked **Live / Not live**. Open one for:
  - **Sequences** — add/delete steps; each step has **A/B variants** you can toggle on/off (enabled variants are split-tested).
  - **Mailboxes** — pick which of your mailboxes send this campaign (sends rotate across them).
  - **Leads** — import per-campaign (CSV with `per1`–`per5`); shows each lead's step + status.
  - **Schedule** — timezone, sending hours, and days.
  - **Analytics** — sequences started, emails sent, replies, reply rate, bounces.
- **Inbox** — replies from every mailbox in one place.

## How reputation is protected

- **Warmup** per mailbox (the fire toggle) with a daily ramp, plus a **health score**.
- **Throttling & daily caps** (default 30 cold/day per mailbox; ramps up while warming).
- **Account rotation** across each campaign's selected mailboxes.
- **Human-like pacing** + **per-campaign sending windows** (timezone-aware).
- **Bounce guardrail** — any mailbox over **3%** bounce rate is auto-paused; bounced leads suppressed.
- **Reply suppression** — replied/bounced leads are dropped from the sequence automatically.

Full playbook (dedicated domains, SPF/DKIM/DMARC, list hygiene), based on Instantly's and Smartlead's docs: **[REPUTATION.md](REPUTATION.md)**. Cheap hosting (~$5/mo): **[HOSTING.md](HOSTING.md)**.

## Quick start

**Easiest (no terminal):** install [Node.js](https://nodejs.org) (LTS), then double-click **`start.bat`** (Windows) or **`start.command`** (Mac). It installs everything on first run and opens the dashboard. Full walkthrough in `START-HERE.txt`.

**Or via terminal:**

```bash
cd plexuriomail
npm install
npm run seed              # optional demo data (Amelia's mailbox + a live campaign)
npm start                 # → http://localhost:3000
```

> It's an app with a server — open it at http://localhost:3000, not by double-clicking index.html.

Ships in **dry-run mode** — the full engine runs (sequences, warmup, rotation, suppression) but no real email is sent. Set `DRY_RUN=0` and add a real mailbox to go live.

## Personalization tokens

`{{first_name}}`, `{{last_name}}`, `{{company}}`, `{{email}}`, and `{{per1}}`…`{{per5}}`.

## Project structure

```
plexuriomail/
├─ src/
│  ├─ server.js   API + dashboard; boots engine & scanner
│  ├─ engine.js   sequences, A/B, rotation, schedule, warmup, guardrails
│  ├─ scanner.js  IMAP replies (→ inbox) + bounces (imapflow)
│  ├─ mailer.js   nodemailer wrapper (no tracking, no unsubscribe)
│  ├─ db.js       SQLite schema + helpers
│  └─ seed.js     demo data
├─ public/index.html   single-file dashboard (Plexurio styling)
├─ test/engine.test.js
├─ REPUTATION.md  ·  HOSTING.md  ·  .env.example
```

Run checks: `npm run test:engine`.

## Notes
- `better-sqlite3` is primary; falls back to Node's built-in `node:sqlite` if it can't compile.
- Mailbox passwords live in the local SQLite file — put the dashboard behind auth/HTTPS in production (see HOSTING.md).

## Responsible use
Cold email is regulated (CAN-SPAM, GDPR/PECR, Gmail/Yahoo bulk-sender rules). You've chosen to omit unsubscribe links; note that bulk senders to Gmail/Yahoo are required to offer one-click unsubscribe above ~5k/day. Only email people you have a lawful basis to contact, and honor opt-outs.
