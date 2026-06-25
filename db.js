// SQLite data layer for PlexurioMail (Instantly-style model).
// Primary backend: better-sqlite3; falls back to Node's built-in node:sqlite.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DB_PATH = process.env.DB_PATH ? path.resolve(ROOT, process.env.DB_PATH) : path.join(ROOT, 'data', 'plexuriomail.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = await openDatabase(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

async function openDatabase(file) {
  try { const { default: Better } = await import('better-sqlite3'); return new Better(file); }
  catch {
    try { const { DatabaseSync } = await import('node:sqlite'); return wrapNodeSqlite(new DatabaseSync(file)); }
    catch { throw new Error('No SQLite backend available. Run "npm install", or use Node.js 22 or newer.'); }
  }
}
function wrapNodeSqlite(d) {
  return {
    pragma: (s) => d.exec(`PRAGMA ${s};`),
    exec: (s) => d.exec(s),
    prepare: (sql) => {
      const st = d.prepare(sql);
      return {
        get: (...a) => st.get(...a),
        all: (...a) => st.all(...a),
        run: (...a) => { const r = st.run(...a); return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }; },
      };
    },
    transaction: (fn) => (...args) => { d.exec('BEGIN'); try { const r = fn(...args); d.exec('COMMIT'); return r; } catch (e) { try { d.exec('ROLLBACK'); } catch {} throw e; } },
    close: () => d.close(),
  };
}

db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, from_name TEXT, from_email TEXT NOT NULL,
  smtp_host TEXT NOT NULL, smtp_port INTEGER NOT NULL DEFAULT 587, smtp_secure INTEGER NOT NULL DEFAULT 0,
  smtp_user TEXT NOT NULL, smtp_pass TEXT NOT NULL,
  imap_host TEXT, imap_port INTEGER NOT NULL DEFAULT 993, imap_secure INTEGER NOT NULL DEFAULT 1, imap_user TEXT, imap_pass TEXT,
  daily_limit INTEGER NOT NULL DEFAULT 30, min_gap_seconds INTEGER NOT NULL DEFAULT 120, max_gap_seconds INTEGER NOT NULL DEFAULT 600,
  warmup_enabled INTEGER NOT NULL DEFAULT 0, warmup_initial INTEGER NOT NULL DEFAULT 5, warmup_increment INTEGER NOT NULL DEFAULT 5,
  warmup_target INTEGER NOT NULL DEFAULT 30, warmup_started_at TEXT, warmup_next_due TEXT,
  status TEXT NOT NULL DEFAULT 'active', last_error TEXT, last_sent_at TEXT, next_due_at TEXT, imap_last_scan TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE,
  first_name TEXT, last_name TEXT, company TEXT,
  per1 TEXT, per2 TEXT, per3 TEXT, per4 TEXT, per5 TEXT,
  status TEXT NOT NULL DEFAULT 'active', last_event_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'paused',         -- live | paused
  tz TEXT NOT NULL DEFAULT 'UTC', send_start INTEGER NOT NULL DEFAULT 9, send_end INTEGER NOT NULL DEFAULT 17,
  send_days TEXT NOT NULL DEFAULT '1-5', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS campaign_accounts (
  campaign_id INTEGER NOT NULL, account_id INTEGER NOT NULL,
  PRIMARY KEY (campaign_id, account_id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS sequences (
  id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id INTEGER NOT NULL,
  step_index INTEGER NOT NULL, delay_days INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sequence_id INTEGER NOT NULL,
  ab TEXT NOT NULL DEFAULT 'A', subject TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
  FOREIGN KEY (sequence_id) REFERENCES sequences(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS enrollments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id INTEGER NOT NULL, lead_id INTEGER NOT NULL, account_id INTEGER,
  current_step INTEGER NOT NULL DEFAULT 0, next_due_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',         -- active | done | replied | bounced | stopped
  created_at TEXT NOT NULL,
  UNIQUE (campaign_id, lead_id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id INTEGER NOT NULL, lead_id INTEGER NOT NULL, account_id INTEGER,
  step_index INTEGER, variant_label TEXT, status TEXT NOT NULL DEFAULT 'sent',  -- sent | bounced | failed
  subject TEXT, body TEXT, error TEXT, preview_url TEXT, sent_at TEXT, created_at TEXT NOT NULL,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS warmup_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL,
  peer TEXT, type TEXT NOT NULL DEFAULT 'sent',   -- sent | received | replied | rescued
  created_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, lead_id INTEGER,
  from_email TEXT, subject TEXT, snippet TEXT, received_at TEXT, read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_acct ON messages(account_id, status, sent_at);
CREATE INDEX IF NOT EXISTS idx_msg_camp ON messages(campaign_id);
CREATE INDEX IF NOT EXISTS idx_enr_due ON enrollments(campaign_id, status, next_due_at);
CREATE INDEX IF NOT EXISTS idx_warm ON warmup_log(account_id, created_at);
`);

export const nowIso = () => new Date().toISOString();
export const todayKey = () => new Date().toISOString().slice(0, 10);

// Real cold emails sent today (excludes warmup).
export function sentTodayCount(accountId) {
  return db.prepare(`SELECT COUNT(*) c FROM messages WHERE account_id=? AND status IN ('sent','bounced') AND substr(sent_at,1,10)=?`)
    .get(accountId, todayKey()).c;
}
export function warmupTodayCount(accountId) {
  return db.prepare(`SELECT COUNT(*) c FROM warmup_log WHERE account_id=? AND type='sent' AND substr(created_at,1,10)=?`).get(accountId, todayKey()).c;
}
// Today's warmup activity breakdown for a mailbox.
export function warmupStats(accountId) {
  const today = todayKey();
  const g = (t) => db.prepare(`SELECT COUNT(*) c FROM warmup_log WHERE account_id=? AND type=? AND substr(created_at,1,10)=?`).get(accountId, t, today).c;
  return { sent: g('sent'), received: g('received'), replied: g('replied'), rescued: g('rescued') };
}
// Cold daily cap, ramped up while warming.
export function effectiveDailyCap(acc) {
  if (!acc.warmup_enabled) return acc.daily_limit;
  const start = acc.warmup_started_at || acc.created_at;
  const days = Math.max(0, Math.floor((Date.now() - Date.parse(start)) / 86400000));
  return Math.min(acc.daily_limit, acc.warmup_initial + acc.warmup_increment * days);
}
// Warmup emails/day target, also ramped.
export function warmupTarget(acc) {
  // Warmup ramp is independent of the cold-send cap: starts at 5/day and climbs
  // +5/day toward warmup_target. (Cold cap uses effectiveDailyCap.)
  if (!acc.warmup_enabled) return 0;
  const start = acc.warmup_started_at || acc.created_at;
  const days = Math.max(0, Math.floor((Date.now() - Date.parse(start)) / 86400000));
  return Math.min(acc.warmup_target || 30, 5 + 5 * days);
}
export function accountBounceStats(accountId, days = 14) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const r = db.prepare(`SELECT SUM(status IN ('sent','bounced')) sent, SUM(status='bounced') bounced FROM messages WHERE account_id=? AND sent_at>=?`).get(accountId, since);
  const sent = r.sent || 0, bounced = r.bounced || 0;
  return { sent, bounced, rate: sent ? bounced / sent : 0 };
}
// 0-100 mailbox health, like Instantly's score.
export function healthScore(acc) {
  const bs = accountBounceStats(acc.id);
  let s = 100;
  if (!acc.warmup_enabled) s -= 15;
  s -= Math.round(bs.rate * 100) * 5;
  if (acc.status === 'error') s -= 40;
  else if (acc.status === 'paused') s -= 10;
  return Math.max(0, Math.min(100, s));
}
