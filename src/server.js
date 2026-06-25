import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { db, nowIso, sentTodayCount, warmupTodayCount, warmupStats, effectiveDailyCap, warmupTarget, accountBounceStats, healthScore } from './db.js';
import { verifyAccount, isDryRun } from './mailer.js';
import { startEngine, pauseEngine, resumeEngine, engineState, tickOnce } from './engine.js';
import { scanAll, startScanner, verifyImap } from './scanner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const TICK_MS = Number(process.env.ENGINE_TICK_MS) || 4000;
const SCAN_MS = Number(process.env.SCAN_INTERVAL_MS) || 300000;

const app = express();
app.use(express.json({ limit: '8mb' }));
// Optional password protection for the dashboard (set DASH_PASS when hosting publicly).
const DASH_USER = process.env.DASH_USER || 'admin';
const DASH_PASS = process.env.DASH_PASS || '';
if (DASH_PASS) {
  app.use((req, res, next) => {
    const [, b64] = (req.headers.authorization || '').split(' ');
    const [u, p] = Buffer.from(b64 || '', 'base64').toString().split(':');
    if (u === DASH_USER && p === DASH_PASS) return next();
    res.set('WWW-Authenticate', 'Basic realm="PlexurioMail"').status(401).send('Authentication required');
  });
}
app.use(express.static(path.join(__dirname, '..', 'public')));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => { console.error(e); res.status(500).json({ error: String(e?.message || e) }); });
const intBool = (v, d = 0) => (v === undefined || v === null || v === '' ? d : v ? 1 : 0);
const PERS = ['per1', 'per2', 'per3', 'per4', 'per5'];

/* ------------------------------ SUMMARY ------------------------------ */
app.get('/api/engine', (req, res) => res.json({ ...engineState(), dryRun: isDryRun(), tickMs: TICK_MS }));
app.post('/api/engine/pause', (req, res) => { pauseEngine(); res.json(engineState()); });
app.post('/api/engine/resume', (req, res) => { resumeEngine(); res.json(engineState()); });
app.post('/api/engine/tick', wrap(async (req, res) => { await tickOnce(); res.json({ ok: true }); }));
app.post('/api/scan', wrap(async (req, res) => res.json(await scanAll())));

app.get('/api/summary', (req, res) => {
  const c = (sql) => db.prepare(sql).get().c;
  res.json({
    dryRun: isDryRun(), engine: engineState(),
    mailboxes: c(`SELECT COUNT(*) c FROM accounts`),
    campaigns: c(`SELECT COUNT(*) c FROM campaigns`),
    liveCampaigns: c(`SELECT COUNT(*) c FROM campaigns WHERE status='live'`),
    unreadReplies: c(`SELECT COUNT(*) c FROM replies WHERE read=0`),
  });
});

/* ------------------------------ MAILBOXES ---------------------------- */
function accountView(a) {
  const bs = accountBounceStats(a.id);
  return {
    id: a.id, name: a.name, from_name: a.from_name, from_email: a.from_email,
    smtp_host: a.smtp_host, smtp_port: a.smtp_port, imap_host: a.imap_host, imap_port: a.imap_port,
    daily_limit: a.daily_limit, status: a.status, last_error: a.last_error,
    warmup_enabled: !!a.warmup_enabled, warmupToday: warmupTodayCount(a.id), warmupTarget: warmupTarget(a), warmup: warmupStats(a.id),
    sentToday: sentTodayCount(a.id), cap: effectiveDailyCap(a),
    health: healthScore(a), bounceRate: bs.rate, bounceSample: bs.sent,
    imap_configured: !!(a.imap_host && a.imap_user),
  };
}
app.get('/api/accounts', (req, res) => res.json(db.prepare(`SELECT * FROM accounts ORDER BY id`).all().map(accountView)));

function accountFromBody(b, base = {}) {
  const port = Number(b.smtp_port ?? base.smtp_port) || 587;
  return {
    name: b.name ?? base.name, from_name: b.from_name ?? base.from_name ?? '', from_email: b.from_email ?? base.from_email,
    smtp_host: b.smtp_host ?? base.smtp_host, smtp_port: port, smtp_secure: intBool(b.smtp_secure ?? base.smtp_secure, port === 465 ? 1 : 0),
    smtp_user: b.smtp_user ?? base.smtp_user,
    imap_host: b.imap_host ?? base.imap_host ?? '', imap_port: Number(b.imap_port ?? base.imap_port) || 993,
    imap_secure: intBool(b.imap_secure ?? base.imap_secure, 1), imap_user: b.imap_user ?? base.imap_user ?? '',
    daily_limit: Number(b.daily_limit ?? base.daily_limit) || 30,
    min_gap_seconds: Number(b.min_gap_seconds ?? base.min_gap_seconds) || 120, max_gap_seconds: Number(b.max_gap_seconds ?? base.max_gap_seconds) || 600,
    warmup_target: Number(b.warmup_target ?? base.warmup_target) || 30,
    warmup_initial: Number(b.warmup_initial ?? base.warmup_initial) || 5, warmup_increment: Number(b.warmup_increment ?? base.warmup_increment) || 5,
  };
}
app.post('/api/accounts', (req, res) => {
  const b = req.body || {};
  for (const f of ['name', 'from_email', 'smtp_host', 'smtp_user', 'smtp_pass']) if (!b[f]) return res.status(400).json({ error: `Missing required field: ${f}` });
  const a = accountFromBody(b);
  const info = db.prepare(
    `INSERT INTO accounts (name,from_name,from_email,smtp_host,smtp_port,smtp_secure,smtp_user,smtp_pass,
       imap_host,imap_port,imap_secure,imap_user,imap_pass,daily_limit,min_gap_seconds,max_gap_seconds,
       warmup_enabled,warmup_initial,warmup_increment,warmup_target,warmup_started_at,status,created_at)
     VALUES (@name,@from_name,@from_email,@smtp_host,@smtp_port,@smtp_secure,@smtp_user,@smtp_pass,
       @imap_host,@imap_port,@imap_secure,@imap_user,@imap_pass,@daily_limit,@min_gap_seconds,@max_gap_seconds,
       0,@warmup_initial,@warmup_increment,@warmup_target,NULL,'active',@created_at)`
  ).run({ ...a, smtp_pass: b.smtp_pass, imap_pass: b.imap_pass || '', created_at: nowIso() });
  res.json(accountView(db.prepare(`SELECT * FROM accounts WHERE id=?`).get(info.lastInsertRowid)));
});
app.put('/api/accounts/:id', (req, res) => {
  const acc = db.prepare(`SELECT * FROM accounts WHERE id=?`).get(req.params.id);
  if (!acc) return res.status(404).json({ error: 'Account not found' });
  const b = req.body || {}, a = accountFromBody(b, acc);
  const smtp_pass = b.smtp_pass && b.smtp_pass !== '********' ? b.smtp_pass : acc.smtp_pass;
  const imap_pass = b.imap_pass && b.imap_pass !== '********' ? b.imap_pass : acc.imap_pass;
  db.prepare(`UPDATE accounts SET name=@name,from_name=@from_name,from_email=@from_email,smtp_host=@smtp_host,smtp_port=@smtp_port,
      smtp_secure=@smtp_secure,smtp_user=@smtp_user,smtp_pass=@smtp_pass,imap_host=@imap_host,imap_port=@imap_port,imap_secure=@imap_secure,
      imap_user=@imap_user,imap_pass=@imap_pass,daily_limit=@daily_limit,min_gap_seconds=@min_gap_seconds,max_gap_seconds=@max_gap_seconds,
      warmup_initial=@warmup_initial,warmup_increment=@warmup_increment,warmup_target=@warmup_target WHERE id=@id`)
    .run({ ...a, id: acc.id, smtp_pass, imap_pass });
  res.json(accountView(db.prepare(`SELECT * FROM accounts WHERE id=?`).get(acc.id)));
});
app.delete('/api/accounts/:id', (req, res) => { db.prepare(`DELETE FROM accounts WHERE id=?`).run(req.params.id); res.json({ ok: true }); });
// Fire toggle: warm up this mailbox on/off.
app.post('/api/accounts/:id/warmup', (req, res) => {
  const acc = db.prepare(`SELECT * FROM accounts WHERE id=?`).get(req.params.id);
  if (!acc) return res.status(404).json({ error: 'Account not found' });
  const on = req.body?.on ? 1 : 0;
  db.prepare(`UPDATE accounts SET warmup_enabled=?, warmup_started_at=COALESCE(warmup_started_at,?) WHERE id=?`)
    .run(on, on ? nowIso() : acc.warmup_started_at, acc.id);
  res.json(accountView(db.prepare(`SELECT * FROM accounts WHERE id=?`).get(acc.id)));
});
app.post('/api/accounts/:id/pause', (req, res) => { db.prepare(`UPDATE accounts SET status='paused' WHERE id=?`).run(req.params.id); res.json({ ok: true }); });
app.post('/api/accounts/:id/resume', (req, res) => { db.prepare(`UPDATE accounts SET status='active', last_error=NULL WHERE id=?`).run(req.params.id); res.json({ ok: true }); });
app.post('/api/accounts/:id/test', wrap(async (req, res) => {
  const acc = db.prepare(`SELECT * FROM accounts WHERE id=?`).get(req.params.id);
  if (!acc) return res.status(404).json({ error: 'Account not found' });
  try {
    await verifyAccount(acc);
    let imap = null;
    if (acc.imap_host && acc.imap_user) { try { await verifyImap(acc); imap = true; } catch (e) { imap = false; } }
    db.prepare(`UPDATE accounts SET last_error=NULL WHERE id=?`).run(acc.id);
    res.json({ ok: true, dryRun: isDryRun(), smtp: true, imap });
  } catch (err) { const m = String(err?.message || err); db.prepare(`UPDATE accounts SET last_error=? WHERE id=?`).run(m, acc.id); res.status(400).json({ ok: false, error: m }); }
}));

/* -------------------------------- LEADS ------------------------------ */
function parseCsv(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  let cols = ['email', 'first_name', 'last_name', 'company', ...PERS], start = 0;
  if (/email/i.test(lines[0])) { cols = lines[0].split(',').map((c) => c.trim().toLowerCase().replace(/\s+/g, '_')); start = 1; }
  const out = [];
  for (let i = start; i < lines.length; i++) {
    const parts = lines[i].split(',').map((p) => p.trim());
    const row = {}; cols.forEach((c, idx) => (row[c] = parts[idx] || ''));
    if (row.email && /.+@.+\..+/.test(row.email)) out.push(row);
  }
  return out;
}
function upsertLead(r) {
  const email = String(r.email).toLowerCase().trim();
  db.prepare(`INSERT OR IGNORE INTO leads (email,first_name,last_name,company,per1,per2,per3,per4,per5,status,created_at)
              VALUES (?,?,?,?,?,?,?,?,?, 'active', ?)`)
    .run(email, r.first_name || '', r.last_name || '', r.company || '', r.per1 || '', r.per2 || '', r.per3 || '', r.per4 || '', r.per5 || '', nowIso());
  return db.prepare(`SELECT id FROM leads WHERE email=?`).get(email).id;
}
function rowsFromBody(b) {
  if (Array.isArray(b.leads)) return b.leads;
  if (typeof b.csv === 'string') return parseCsv(b.csv);
  if (b.email) return [b];
  return [];
}
app.get('/api/leads', (req, res) => res.json(db.prepare(`SELECT * FROM leads ORDER BY id DESC LIMIT 1000`).all()));

/* ------------------------------ CAMPAIGNS ---------------------------- */
function addStep(campaignId, delay_days) {
  const max = db.prepare(`SELECT MAX(step_index) m FROM sequences WHERE campaign_id=?`).get(campaignId).m;
  const idx = max == null ? 0 : max + 1;
  const sid = db.prepare(`INSERT INTO sequences (campaign_id,step_index,delay_days,created_at) VALUES (?,?,?,?)`).run(campaignId, idx, Number(delay_days) || 0, nowIso()).lastInsertRowid;
  db.prepare(`INSERT INTO variants (sequence_id,ab,subject,body,enabled,created_at) VALUES (?,?,?,?,1,?)`).run(sid, 'A', '', '', nowIso());
  db.prepare(`INSERT INTO variants (sequence_id,ab,subject,body,enabled,created_at) VALUES (?,?,?,?,0,?)`).run(sid, 'B', '', '', nowIso());
  return sid;
}
function reindex(campaignId) {
  db.prepare(`SELECT id FROM sequences WHERE campaign_id=? ORDER BY step_index ASC, id ASC`).all(campaignId)
    .forEach((s, i) => db.prepare(`UPDATE sequences SET step_index=? WHERE id=?`).run(i, s.id));
}
function campaignStats(id) {
  const g = (sql) => db.prepare(sql).get(id).c;
  const started = g(`SELECT COUNT(*) c FROM enrollments WHERE campaign_id=?`);
  const replies = g(`SELECT COUNT(*) c FROM enrollments WHERE campaign_id=? AND status='replied'`);
  return {
    started, replies,
    sent: g(`SELECT COUNT(*) c FROM messages WHERE campaign_id=? AND status IN ('sent','bounced')`),
    bounces: g(`SELECT COUNT(*) c FROM messages WHERE campaign_id=? AND status='bounced'`),
    replyRate: started ? replies / started : 0,
  };
}
app.get('/api/campaigns', (req, res) => {
  res.json(db.prepare(`SELECT * FROM campaigns ORDER BY id DESC`).all().map((c) => ({
    ...c, mailboxes: db.prepare(`SELECT COUNT(*) c FROM campaign_accounts WHERE campaign_id=?`).get(c.id).c, stats: campaignStats(c.id),
  })));
});
app.post('/api/campaigns', (req, res) => {
  if (!req.body?.name) return res.status(400).json({ error: 'Missing name' });
  const id = db.prepare(`INSERT INTO campaigns (name,status,created_at) VALUES (?, 'paused', ?)`).run(req.body.name, nowIso()).lastInsertRowid;
  addStep(id, 0); // first email
  res.json(db.prepare(`SELECT * FROM campaigns WHERE id=?`).get(id));
});
app.get('/api/campaigns/:id', (req, res) => {
  const c = db.prepare(`SELECT * FROM campaigns WHERE id=?`).get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Campaign not found' });
  res.json({ ...c, stats: campaignStats(c.id) });
});
app.put('/api/campaigns/:id', (req, res) => {
  const c = db.prepare(`SELECT * FROM campaigns WHERE id=?`).get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Campaign not found' });
  const b = req.body || {};
  db.prepare(`UPDATE campaigns SET name=?, tz=?, send_start=?, send_end=?, send_days=? WHERE id=?`).run(
    b.name ?? c.name, b.tz ?? c.tz, Number(b.send_start ?? c.send_start), Number(b.send_end ?? c.send_end), b.send_days ?? c.send_days, c.id);
  res.json(db.prepare(`SELECT * FROM campaigns WHERE id=?`).get(c.id));
});
app.delete('/api/campaigns/:id', (req, res) => { db.prepare(`DELETE FROM campaigns WHERE id=?`).run(req.params.id); res.json({ ok: true }); });
app.post('/api/campaigns/:id/live', (req, res) => {
  const live = req.body?.live ? 'live' : 'paused';
  if (live === 'live') {
    const id = req.params.id;
    if (!db.prepare(`SELECT COUNT(*) c FROM campaign_accounts WHERE campaign_id=?`).get(id).c) return res.status(400).json({ error: 'Select at least one mailbox first.' });
    if (!db.prepare(`SELECT COUNT(*) c FROM enrollments WHERE campaign_id=? AND status='active'`).get(id).c) return res.status(400).json({ error: 'Add leads first.' });
    const hasContent = db.prepare(`SELECT COUNT(*) c FROM variants v JOIN sequences s ON s.id=v.sequence_id WHERE s.campaign_id=? AND v.enabled=1 AND (v.subject<>'' OR v.body<>'')`).get(id).c;
    if (!hasContent) return res.status(400).json({ error: 'Write at least one enabled email variant first.' });
  }
  db.prepare(`UPDATE campaigns SET status=? WHERE id=?`).run(live, req.params.id);
  res.json({ ok: true, status: live });
});

// campaign <-> mailboxes
app.get('/api/campaigns/:id/accounts', (req, res) => {
  const assigned = db.prepare(`SELECT account_id FROM campaign_accounts WHERE campaign_id=?`).all(req.params.id).map((r) => r.account_id);
  res.json({ assigned, available: db.prepare(`SELECT id,name,from_email,status FROM accounts ORDER BY id`).all() });
});
app.put('/api/campaigns/:id/accounts', (req, res) => {
  const id = req.params.id, ids = Array.isArray(req.body?.account_ids) ? req.body.account_ids : [];
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM campaign_accounts WHERE campaign_id=?`).run(id);
    const ins = db.prepare(`INSERT OR IGNORE INTO campaign_accounts (campaign_id,account_id) VALUES (?,?)`);
    for (const a of ids) ins.run(id, a);
  });
  tx();
  res.json({ ok: true, assigned: ids });
});

// sequences + variants
app.get('/api/campaigns/:id/sequences', (req, res) => {
  const steps = db.prepare(`SELECT * FROM sequences WHERE campaign_id=? ORDER BY step_index ASC`).all(req.params.id);
  res.json(steps.map((s) => ({ ...s, variants: db.prepare(`SELECT * FROM variants WHERE sequence_id=? ORDER BY ab`).all(s.id) })));
});
app.post('/api/campaigns/:id/sequences', (req, res) => { addStep(req.params.id, req.body?.delay_days || 0); res.json({ ok: true }); });
app.put('/api/sequences/:id', (req, res) => { db.prepare(`UPDATE sequences SET delay_days=? WHERE id=?`).run(Number(req.body?.delay_days) || 0, req.params.id); res.json({ ok: true }); });
app.delete('/api/sequences/:id', (req, res) => {
  const seq = db.prepare(`SELECT * FROM sequences WHERE id=?`).get(req.params.id);
  if (!seq) return res.json({ ok: true });
  db.prepare(`DELETE FROM sequences WHERE id=?`).run(req.params.id);
  reindex(seq.campaign_id);
  res.json({ ok: true });
});
app.put('/api/variants/:id', (req, res) => {
  const v = db.prepare(`SELECT * FROM variants WHERE id=?`).get(req.params.id);
  if (!v) return res.status(404).json({ error: 'Variant not found' });
  const b = req.body || {};
  db.prepare(`UPDATE variants SET subject=?, body=?, enabled=? WHERE id=?`).run(b.subject ?? v.subject, b.body ?? v.body, intBool(b.enabled ?? v.enabled, v.enabled), v.id);
  res.json({ ok: true });
});

// per-campaign leads (enrollments)
app.get('/api/campaigns/:id/leads', (req, res) => {
  res.json(db.prepare(
    `SELECT e.id enrollment_id, e.status enr_status, e.current_step, l.id lead_id, l.email, l.first_name, l.last_name, l.company, l.status lead_status
     FROM enrollments e JOIN leads l ON l.id=e.lead_id WHERE e.campaign_id=? ORDER BY e.id DESC LIMIT 1000`).all(req.params.id));
});
app.post('/api/campaigns/:id/leads', (req, res) => {
  const id = req.params.id;
  if (!db.prepare(`SELECT id FROM campaigns WHERE id=?`).get(id)) return res.status(404).json({ error: 'Campaign not found' });
  const rows = rowsFromBody(req.body || {});
  if (!rows.length) return res.status(400).json({ error: 'Provide csv, leads[], or a single lead.' });
  let added = 0;
  const enroll = db.prepare(`INSERT OR IGNORE INTO enrollments (campaign_id,lead_id,current_step,next_due_at,status,created_at) VALUES (?,?,0,?, 'active', ?)`);
  const tx = db.transaction(() => { for (const r of rows) { if (!r.email) continue; const lid = upsertLead(r); added += enroll.run(id, lid, nowIso(), nowIso()).changes; } });
  tx();
  res.json({ received: rows.length, enrolled: added });
});
app.delete('/api/campaigns/:id/leads/:leadId', (req, res) => { db.prepare(`DELETE FROM enrollments WHERE campaign_id=? AND lead_id=?`).run(req.params.id, req.params.leadId); res.json({ ok: true }); });

/* ------------------------------- INBOX ------------------------------- */
app.get('/api/inbox', (req, res) => {
  res.json(db.prepare(
    `SELECT r.*, a.name account_name, a.from_email account_email, l.first_name, l.company
     FROM replies r LEFT JOIN accounts a ON a.id=r.account_id LEFT JOIN leads l ON l.id=r.lead_id
     ORDER BY r.received_at DESC LIMIT 500`).all());
});
app.post('/api/inbox/:id/read', (req, res) => { db.prepare(`UPDATE replies SET read=1 WHERE id=?`).run(req.params.id); res.json({ ok: true }); });

/* -------------------------------- BOOT ------------------------------- */
app.listen(PORT, () => {
  console.log(`\n  PlexurioMail running:  http://localhost:${PORT}`);
  console.log(`  Mode:                  ${isDryRun() ? 'DRY RUN (no real emails)' : 'LIVE (real SMTP/IMAP)'}`);
  startEngine(TICK_MS);
  startScanner(SCAN_MS);
});
