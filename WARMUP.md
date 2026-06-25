# How PlexurioMail's email warmup works

Warmup builds a mailbox's sending reputation **before** you send cold email, and keeps it healthy while you do. New mailboxes that suddenly send cold email look suspicious to Gmail/Outlook and land in spam. Warmup makes a mailbox look like a normal human inbox first: it sends and receives real messages that get opened, replied to, marked important, and pulled out of spam.

PlexurioMail has this built in as a **private peer-to-peer warmup pool** made of *your own* mailboxes.

## Turning it on

In **Mailboxes**, click the 🔥 **flame** on a mailbox — it turns orange and that mailbox starts warming. You need **at least 2 mailboxes warming** (each with SMTP **and** IMAP configured) so they have someone to talk to.

## What happens, step by step

1. **The pool.** Every mailbox with the flame on joins a private pool.
2. **Sending.** On a ramping daily schedule, with randomized human-like gaps, each warming mailbox emails a **random peer** in the pool a short, natural-looking message (e.g. "Quick question", "Following up"). Every warmup message carries a hidden header, `X-Plexurio-Warmup`, so the other side can recognise it.
3. **Receiving (over IMAP).** The recipient mailbox's scanner finds the tagged message and does the things a healthy, engaged human inbox does — the signals mailbox providers reward:
   - **Opens it** (marks it read),
   - **Flags it important** (⭐),
   - **Rescues it from spam** — if the message landed in Junk/Spam, it's **moved to the Inbox** (one of the strongest positive signals you can send a provider),
   - **Replies** to about 30% of them, so genuine two-way conversations build up.
4. **Ramp-up.** Each mailbox starts gently — about **5 warmup emails on day one, +5 each day**, up to its target (default 30/day). It never spikes.
5. **You can watch it.** Each mailbox row shows warmup **sent / received / replied / rescued** for today, plus a **health score**.

## Why each action helps

| Action | Why it builds reputation |
|--------|--------------------------|
| Gradual ramp | Sudden volume from a new mailbox is the #1 spam trigger; slow growth looks human. |
| Real replies | Two-way conversation is a top trust signal — spam doesn't get replies. |
| Mark as read / important | Tells the provider recipients actively engage with this sender. |
| Rescue from spam | "Move to Inbox" directly teaches the provider this sender is wanted. |
| Human-like gaps | No robotic bursts; mimics a real person's sending pattern. |

## Settings

Per mailbox: warmup target/day (default 30). Globally via `.env`:

```
WARMUP_MIN_GAP=600        # min seconds between warmup sends
WARMUP_MAX_GAP=2400       # max seconds between warmup sends
WARMUP_REPLY_RATE=0.3     # share of received warmup mail that gets a reply
```

## Dry-run vs live

- **Dry-run** (`DRY_RUN=1`): the whole exchange is **simulated** — no real email — so you can watch the counters move and see how it behaves.
- **Live** (`DRY_RUN=0`): mailboxes send to each other for real over SMTP, and the IMAP scanner does the read/flag/rescue/reply actions on each inbox every few minutes.

## Honest limitations

- A pool of **your own** mailboxes is solid and free, but a **large, diverse third-party warmup network** (thousands of unrelated inboxes, like Instantly/Smartlead/Mailreach run) is stronger because the variety of sending domains looks more natural. If you scale up, run one of those in parallel on the same mailboxes — PlexurioMail's pool and an external network can coexist.
- **Keep warmup on permanently**, even once campaigns are live — reputation decays if you stop.
- Warm for **at least 2 weeks** before sending cold email from a new mailbox (3–4 weeks is safer). See `REPUTATION.md`.
