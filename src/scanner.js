// IMAP scanner: detects REPLIES (records them to the unified inbox + stops the
// lead's sequence) and BOUNCES (suppresses the lead + feeds the bounce guardrail).
// Lazy-imports imapflow; no-op in DRY_RUN.
import { db, nowIso } from './db.js';
import { processWarmupMailbox } from './warmup.js';

const DRY_RUN = process.env.DRY_RUN !== '0';
const hasImap = (a) => !!(a.imap_host && a.imap_user && a.imap_pass);

export async function scanAll() {
  if (DRY_RUN) return { accounts: 0, replies: 0, bounces: 0, note: 'dry-run' };
  const accounts = db.prepare(`SELECT * FROM accounts WHERE imap_host IS NOT NULL AND imap_host <> ''`).all();
  const totals = { accounts: 0, replies: 0, bounces: 0 };
  for (const acc of accounts) {
    if (!hasImap(acc)) continue;
    try {
      const r = await scanAccount(acc);
      totals.replies += r.replies; totals.bounces += r.bounces; totals.accounts++;
      db.prepare(`UPDATE accounts SET imap_last_scan=?, last_error=NULL WHERE id=?`).run(nowIso(), acc.id);
    } catch (e) { db.prepare(`UPDATE accounts SET last_error=? WHERE id=?`).run('IMAP: ' + String(e?.message || e), acc.id); }
  }
  return totals;
}

async function scanAccount(acc) {
  const { ImapFlow } = await import('imapflow');
  const client = new ImapFlow({ host: acc.imap_host, port: Number(acc.imap_port) || 993, secure: acc.imap_secure !== 0, auth: { user: acc.imap_user, pass: acc.imap_pass }, logger: false });
  let replies = 0, bounces = 0;
  await client.connect();
  try { await processWarmupMailbox(client, acc); } catch (e) { /* warmup processing best-effort */ }
  const lock = await client.getMailboxLock('INBOX');
  try {
    const since = new Date(Date.now() - 3 * 86400000);
    for await (const msg of client.fetch({ since }, { envelope: true, source: true })) {
      const from = (msg.envelope?.from?.[0]?.address || '').toLowerCase();
      const subject = msg.envelope?.subject || '';
      const src = msg.source ? msg.source.toString() : '';
      if (isBounce(from, subject)) {
        const lead = findLeadInText(src);
        if (lead) { markBounced(acc.id, lead); bounces++; }
      } else {
        const lead = db.prepare(`SELECT * FROM leads WHERE email=?`).get(from);
        if (lead && lead.status === 'active') { recordReply(acc.id, lead, subject, snippet(src), msg.envelope?.date); replies++; }
      }
    }
  } finally { lock.release(); await client.logout().catch(() => {}); }
  return { replies, bounces };
}

function isBounce(from, subject) {
  return /mailer-daemon|postmaster|mail delivery (subsystem|system)/i.test(from) ||
    /undeliver|delivery (status notification|failed|incomplete|has failed)|returned mail|failure notice/i.test(subject);
}
function findLeadInText(text) {
  const lower = (text || '').toLowerCase();
  if (!lower) return null;
  return db.prepare(`SELECT id,email,status FROM leads`).all().find((l) => l.email && lower.includes(l.email.toLowerCase())) || null;
}
function snippet(src) {
  const body = String(src || '').split(/\r?\n\r?\n/).slice(1).join('\n').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return body.slice(0, 200);
}

export function recordReply(accountId, lead, subject, snip, dateIso) {
  db.prepare(`UPDATE leads SET status='replied', last_event_at=? WHERE id=? AND status='active'`).run(nowIso(), lead.id);
  db.prepare(`UPDATE enrollments SET status='replied' WHERE lead_id=? AND status='active'`).run(lead.id);
  db.prepare(`INSERT INTO replies (account_id,lead_id,from_email,subject,snippet,received_at,read,created_at) VALUES (?,?,?,?,?,?,0,?)`)
    .run(accountId, lead.id, lead.email, subject || '', snip || '', dateIso ? new Date(dateIso).toISOString() : nowIso(), nowIso());
}
function markBounced(accountId, lead) {
  db.prepare(`UPDATE leads SET status='bounced', last_event_at=? WHERE id=?`).run(nowIso(), lead.id);
  db.prepare(`UPDATE enrollments SET status='bounced' WHERE lead_id=? AND status='active'`).run(lead.id);
  const m = db.prepare(`SELECT id FROM messages WHERE lead_id=? AND account_id=? AND status='sent' ORDER BY id DESC LIMIT 1`).get(lead.id, accountId)
        || db.prepare(`SELECT id FROM messages WHERE lead_id=? AND status='sent' ORDER BY id DESC LIMIT 1`).get(lead.id);
  if (m) db.prepare(`UPDATE messages SET status='bounced', error='bounced (async DSN)' WHERE id=?`).run(m.id);
}

export async function verifyImap(acc) {
  if (DRY_RUN) return true;
  if (!hasImap(acc)) throw new Error('IMAP not configured');
  const { ImapFlow } = await import('imapflow');
  const client = new ImapFlow({ host: acc.imap_host, port: Number(acc.imap_port) || 993, secure: acc.imap_secure !== 0, auth: { user: acc.imap_user, pass: acc.imap_pass }, logger: false });
  await client.connect(); await client.logout().catch(() => {});
  return true;
}

let timer = null;
export function startScanner(intervalMs = 300000) {
  if (DRY_RUN || timer) return;
  timer = setInterval(() => scanAll().catch((e) => console.error('[scanner]', e)), intervalMs);
  console.log(`[scanner] started (every ${Math.round(intervalMs / 1000)}s)`);
}
