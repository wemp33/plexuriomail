# Keeping your email reputation very good

This is the playbook PlexurioMail is built around. It follows the same principles the big cold-email platforms publish — [Instantly](https://instantly.ai/blog/email-deliverability-best-practices/) and [Smartlead](https://www.smartlead.ai/blog/email-deliverability-guide) — adapted for a self-hosted setup. Most reputation wins are **operational** (domains, DNS, warmup, list hygiene), not code. PlexurioMail enforces the code-side guardrails for you; this doc covers the rest.

> The single biggest rule: **never send cold email from your real company domain.** One spam complaint storm can poison the domain your whole company emails from. Use dedicated sending domains.

---

## 1. Domains & mailboxes (the foundation)

- **Buy dedicated sending domains**, separate from your primary domain. A common pattern is look-alikes of your main domain (e.g. `getacme.com`, `tryacme.com` for `acme.com`). Redirect them to your real site.
- **2–3 mailboxes per domain**, no more. More mailboxes per domain looks unnatural.
- **Scale with more inboxes, not more volume per inbox.** Instantly's math: 300 emails/day ≈ 10 inboxes; 1,000/day ≈ 33 inboxes; 3,000/day ≈ 100 inboxes. ([source](https://instantly.ai/blog/email-deliverability-best-practices/))
- Use a real mailbox provider (Google Workspace, Microsoft 365, or a dedicated cold-email host). Avoid sending through your transactional/marketing ESP.

## 2. Authenticate every domain: SPF, DKIM, DMARC

As of 2025 Google and Microsoft **reject or spam-filter** mail that fails authentication, especially at volume. ([Smartlead](https://www.smartlead.ai/blog/spf-dkim-dmarc)) Set all three **before** you warm up:

- **SPF** — a DNS TXT record listing who may send for your domain. With Google Workspace: `v=spf1 include:_spf.google.com ~all`.
- **DKIM** — turn on DKIM in your mailbox provider and publish the key it gives you (a TXT record like `google._domainkey`). This cryptographically signs every message.
- **DMARC** — a TXT record at `_dmarc.yourdomain.com`, e.g. `v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com`. Start with `p=none` to monitor, then tighten to `quarantine`/`reject`.
- **MX** — make sure the domain has valid MX records (so it can receive — bounces and replies need this; see §6).

Verify with any free SPF/DKIM/DMARC checker after DNS propagates.

## 3. Warm up before you send (and keep it on)

Warmup gradually builds sending reputation by exchanging real-looking emails that get opened, replied to, and marked important — telling Gmail/Outlook your account is a real human. **Skipping warmup is the #1 reason cold email lands in spam.** ([Smartlead](https://www.smartlead.ai/blog/email-deliverability-guide))

- Warm up **14 days minimum, 30 days is safer**, before any cold campaign. ([Instantly](https://instantly.ai/blog/email-warmup-guide/))
- **Keep warmup running permanently**, alongside live campaigns.
- New accounts: start around **10 warmup emails/day** and a low cold volume; ramp up gradually.

**What PlexurioMail does:** it enforces a **warmup volume ramp** — a new mailbox starts at a low daily cap (default 5) and climbs (+5/day) toward its limit, so you can't accidentally blast a cold inbox on day one.

**What you should add:** a real **warmup network**. Peer-warming only your own 2–3 inboxes is weak — the value comes from a large, diverse pool of mailboxes interacting with yours. Run a dedicated warmup service (Instantly, Smartlead, Mailreach, Warmup Inbox, etc.) on the same mailboxes in parallel. This is the one place worth a small monthly spend.

## 4. Volume limits & pacing

- **≤ 30 cold emails/day per mailbox** (Instantly's recommendation), up to ~40–50 at most (Smartlead). PlexurioMail defaults to **30** and lets you set it per mailbox.
- **Rotation:** PlexurioMail spreads sends across all active mailboxes automatically.
- **Human-like gaps:** randomized delay between sends (default 120–600s) — no robotic bursts.
- **Business-hours window:** set each campaign's **Schedule** (timezone, hours, days) so mail only goes out during working hours, like a real person.

## 5. List hygiene (protect your bounce rate)

High bounces are the fastest way to wreck a domain.

- **Verify every list before import** — remove invalid, role-based, and risky/catch-all addresses. Use a verifier (MillionVerifier, ZeroBounce, NeverBounce, etc.).
- Target **bounce rate under 1%**; **pause immediately at 3%**, clean, then resume. ([Instantly](https://instantly.ai/blog/email-deliverability-best-practices/))
- **What PlexurioMail does:** a **bounce-rate guardrail auto-pauses any mailbox above 3%** (after a minimum sample), and suppresses bounced leads so you never email them again. Tune via `BOUNCE_PAUSE_RATE` / `BOUNCE_MIN_SAMPLE`.

## 6. Replies & bounces need IMAP — yes, you need it

To protect reputation you must **stop emailing people who replied or bounced**. That requires reading the inbox, which means **IMAP**:

- **Reply detection** — when a lead replies, PlexurioMail marks them `replied` and stops their sequence. Continuing to cold-email someone who answered is the fastest route to spam complaints.
- **Bounce processing** — many bounces arrive **asynchronously** as a Mailer-Daemon message minutes later; SMTP alone won't catch those. PlexurioMail's IMAP scanner reads them, suppresses the lead, and feeds the bounce guardrail.

Add IMAP credentials on each mailbox. Replies also land in the unified **Inbox**. Without IMAP you fly blind on replies and async bounces — so for a quality setup, **IMAP is required, not optional.**

## 7. Content that doesn't trip filters

- Keep the first email **short, plain, and personal**. Avoid heavy HTML, images, and multiple links in email #1.
- **Personalize** — use `{{first_name}}`, `{{company}}`, and `{{personalization1}}`…`{{personalization5}}` for genuinely custom lines. Identical mass emails are a spam signal.
- Avoid spam-trigger words and aggressive sales language.
- **Unsubscribe links are omitted by design** in PlexurioMail. Note: Gmail/Yahoo require one-click unsubscribe for bulk senders above ~5,000/day — if you reach that volume, add it.
- **Skip open/click tracking on cold email** if you can — tracking pixels and link wrapping can hurt deliverability. (PlexurioMail intentionally does **not** add tracking pixels.)

## 8. Monitor

- Set up **Google Postmaster Tools** for each domain to watch spam rate and reputation.
- Periodically send yourself test emails / use an inbox-placement checker to confirm you're hitting Primary, not Spam/Promotions.

---

## A simple 30-day ramp (per mailbox)

| Days | Warmup/day | Cold/day | Notes |
|------|-----------|----------|-------|
| 1–7   | ~10 | 0 | Warmup only. DNS verified, no cold sending yet. |
| 8–14  | ~15 | 5–10 | Begin light cold volume. |
| 15–21 | ~20 | 10–20 | Ramp up; watch bounces/replies. |
| 22–30 | ~25 | 20–30 | Approach steady state (~30/day). |
| 31+   | keep on | ~30 | Steady state; warmup stays on permanently. |

PlexurioMail's per-mailbox warmup ramp mirrors the cold column; run a warmup service for the warmup column.

---

### Sources
- Instantly — [Email Deliverability Best Practices](https://instantly.ai/blog/email-deliverability-best-practices/), [Email Warmup Guide](https://instantly.ai/blog/email-warmup-guide/), [Warmup Settings](https://help.instantly.ai/en/articles/7988514-warmup-settings)
- Smartlead — [Email Deliverability Guide](https://www.smartlead.ai/blog/email-deliverability-guide), [How to Configure SPF, DKIM and DMARC](https://www.smartlead.ai/blog/spf-dkim-dmarc), [Email Warmup Guide](https://api.smartlead.ai/guides/email-warmup)
