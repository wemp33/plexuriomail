// Peer-to-peer email warmup.
//
// Warming mailboxes email EACH OTHER on a ramping daily schedule. Every warmup
// message carries an "X-Plexurio-Warmup" header so the receiving side can spot it
// and do the things that build sender reputation: open it (mark read), flag it as
// important, rescue it from Spam into the Inbox, and reply to a share of them so
// real two-way conversations build up. Needs >= 2 mailboxes with warmup on.
//
// DRY_RUN simulates the whole exchange (no network) so you can watch it work.
import { db, nowIso, warmupTodayCount, warmupTarget } from './db.js';
import { sendEmail, isDryRun } from './mailer.js';

const DRY = isDryRun();
export const WARMUP_HEADER = 'X-Plexurio-Warmup';
const MIN = Number(process.env.WARMUP_MIN_GAP || 600);
const MAX = Number(process.env.WARMUP_MAX_GAP || 2400);
const REPLY_RATE = Number(process.env.WARMUP_REPLY_RATE || 0.3);   // share of warmup mail replied to
const SPAM_RATE = Number(process.env.WARMUP_SPAM_RATE || 0.2);     // share that lands in spam (rescued) — simulation only

const SUBJECTS = ['Quick question', 'Following up', 'Re: catching up', 'Coffee next week?', 'Notes from today', 'Re: that idea', 'Hello there', 'Re: thanks', 'Re: the plan', 'Checking in'];
const BODIES = ['Thanks for the note — talk soon.', 'Sounds good, let me know what works.', 'Appreciate it, chatting next week.', 'Great catching up earlier. Cheers.', 'Got it — will follow up shortly.', 'Perfect, thank you!', 'Looks good to me.', 'Yes, let us do that.'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const rnd = (a, b) => Math.floor(a + Math.random() * (b - a + 1));

export function logWarmup(accountId, peer, type) {
  db.prepare(`INSERT INTO warmup_log (account_id, peer, type, created_at) VALUES (?,?,?,?)`).run(accountId, peer, type, nowIso());
}

// Engine side: one warmup action for a mailbox, paced + capped by the daily ramp.
export async function stepWarmup(acc) {
  if (!acc.warmup_enabled) return;
  if (warmupTodayCount(acc.id) >= warmupTarget(acc)) return;
  if (acc.warmup_next_due && Date.parse(acc.warmup_next_due) > Date.now()) return;

  const peers = db.prepare(`SELECT * FROM accounts WHERE warmup_enabled=1 AND status='active' AND id<>?`).all(acc.id);
  if (peers.length) {
    const peer = pick(peers);
    if (DRY) {
      // Simulate the full exchange so the dashboard shows realistic activity.
      logWarmup(acc.id, peer.from_email, 'sent');
      logWarmup(peer.id, acc.from_email, 'received');
      if (Math.random() < SPAM_RATE) logWarmup(peer.id, acc.from_email, 'rescued');
      if (Math.random() < REPLY_RATE) { logWarmup(peer.id, acc.from_email, 'replied'); logWarmup(acc.id, peer.from_email, 'received'); }
    } else {
      try {
        await sendEmail(acc, { to: peer.from_email, subject: pick(SUBJECTS), text: pick(BODIES), headers: { [WARMUP_HEADER]: '1' } });
        logWarmup(acc.id, peer.from_email, 'sent');
      } catch (e) {
        db.prepare(`UPDATE accounts SET last_error=? WHERE id=?`).run('Warmup send: ' + String(e?.message || e), acc.id);
      }
    }
  }
  db.prepare(`UPDATE accounts SET warmup_next_due=? WHERE id=?`).run(new Date(Date.now() + rnd(MIN, MAX) * 1000).toISOString(), acc.id);
}

const isWarmup = (src) => /^x-plexurio-warmup:/im.test(String(src || ''));
const fromAddr = (m) => (m.envelope?.from?.[0]?.address || '').toLowerCase();

// Scanner side (live IMAP): rescue warmup mail from spam, mark read+important, reply to a share.
export async function processWarmupMailbox(client, acc) {
  let received = 0, replied = 0, rescued = 0;
  const since = new Date(Date.now() - 7 * 86400000);
  for (const junk of ['[Gmail]/Spam', 'Junk', 'Junk Email', 'Spam', 'Bulk Mail']) {
    try {
      const lock = await client.getMailboxLock(junk);
      try {
        for await (const m of client.fetch({ since }, { uid: true, source: true, envelope: true })) {
          if (!isWarmup(m.source?.toString())) continue;
          await client.messageMove(m.uid, 'INBOX', { uid: true });
          rescued++; logWarmup(acc.id, fromAddr(m), 'rescued');
        }
      } finally { lock.release(); }
    } catch { /* folder may not exist */ }
  }
  const lock = await client.getMailboxLock('INBOX');
  try {
    for await (const m of client.fetch({ seen: false, since }, { uid: true, source: true, envelope: true })) {
      if (!isWarmup(m.source?.toString())) continue;
      await client.messageFlagsAdd(m.uid, ['\\Seen', '\\Flagged'], { uid: true });
      received++; logWarmup(acc.id, fromAddr(m), 'received');
      if (Math.random() < REPLY_RATE) {
        const to = fromAddr(m);
        if (to) { try { await sendEmail(acc, { to, subject: 'Re: ' + (m.envelope?.subject || 'note'), text: pick(BODIES), headers: { [WARMUP_HEADER]: '1' } }); replied++; logWarmup(acc.id, to, 'replied'); } catch {} }
      }
    }
  } finally { lock.release(); }
  return { received, replied, rescued };
}
