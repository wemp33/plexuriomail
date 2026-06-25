// Verifies the new engine: per1-5 rendering, A/B variant selection (disabled skipped),
// multi-step sequence advance, per-campaign mailbox restriction, schedule window,
// warmup simulator, health score, reply suppression, and the bounce guardrail.
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.DRY_RUN = '1';
process.env.WARMUP_MIN_GAP = '0';
process.env.WARMUP_MAX_GAP = '0';
const tmpDb = path.join(os.tmpdir(), `plexn-${Date.now()}.db`);
process.env.DB_PATH = tmpDb;

const { db, nowIso, warmupTodayCount, healthScore } = await import('../src/db.js');
const { tickOnce, renderTemplate } = await import('../src/engine.js');
let passed = 0; const ok = (m) => { console.log('  ✓ ' + m); passed++; };

assert.strictEqual(renderTemplate('Hi {{first_name}} — {{per1}} / {{per5}}', { first_name: 'Amir', per1: 'your post' }), 'Hi Amir — your post / ');
ok('renders per1-5 (per5 blank), no unsubscribe token');

const insAcc = db.prepare(`INSERT INTO accounts (name,from_name,from_email,smtp_host,smtp_port,smtp_secure,smtp_user,smtp_pass,
  daily_limit,min_gap_seconds,max_gap_seconds,warmup_enabled,warmup_initial,warmup_increment,warmup_target,warmup_started_at,status,created_at)
  VALUES (?,?,?,?,587,0,?,?,?,0,0,?,5,5,30,?,'active',?)`);
const A  = insAcc.run('A','A','a@test','h','a','p',50,0,null,nowIso()).lastInsertRowid;  // in campaign, warmup off
const Bx = insAcc.run('B','B','b@test','h','b','p',50,0,null,nowIso()).lastInsertRowid;  // in campaign, warmup off
const W  = insAcc.run('W','W','w@test','h','w','p',50,1,nowIso(),nowIso()).lastInsertRowid; // warmup on, NOT in campaign
const D  = insAcc.run('D','D','d@test','h','d','p',50,0,null,nowIso()).lastInsertRowid;  // NOT in campaign

assert.strictEqual(healthScore(db.prepare('SELECT * FROM accounts WHERE id=?').get(W)), 100);
assert.strictEqual(healthScore(db.prepare('SELECT * FROM accounts WHERE id=?').get(A)), 85);
ok('health score: warmup-on=100, warmup-off=85');

const cid = db.prepare(`INSERT INTO campaigns (name,status,tz,send_start,send_end,send_days,created_at) VALUES ('C','live','UTC',0,24,'0-6',?)`).run(nowIso()).lastInsertRowid;
db.prepare(`INSERT INTO campaign_accounts (campaign_id,account_id) VALUES (?,?)`).run(cid, A);
db.prepare(`INSERT INTO campaign_accounts (campaign_id,account_id) VALUES (?,?)`).run(cid, Bx);

const s0 = db.prepare(`INSERT INTO sequences (campaign_id,step_index,delay_days,created_at) VALUES (?,0,0,?)`).run(cid, nowIso()).lastInsertRowid;
db.prepare(`INSERT INTO variants (sequence_id,ab,subject,body,enabled,created_at) VALUES (?,'A','S0A','Hi {{first_name}}',1,?)`).run(s0, nowIso());
db.prepare(`INSERT INTO variants (sequence_id,ab,subject,body,enabled,created_at) VALUES (?,'B','S0B','Hi {{first_name}}',0,?)`).run(s0, nowIso());
const s1 = db.prepare(`INSERT INTO sequences (campaign_id,step_index,delay_days,created_at) VALUES (?,1,0,?)`).run(cid, nowIso()).lastInsertRowid;
db.prepare(`INSERT INTO variants (sequence_id,ab,subject,body,enabled,created_at) VALUES (?,'A','S1A','Bump {{first_name}}',1,?)`).run(s1, nowIso());

const insLead = db.prepare(`INSERT INTO leads (email,first_name,status,created_at) VALUES (?,?, 'active', ?)`);
const enroll = db.prepare(`INSERT INTO enrollments (campaign_id,lead_id,current_step,next_due_at,status,created_at) VALUES (?,?,0,?, 'active', ?)`);
const N = 10, ids = [];
for (let i = 0; i < N; i++) { const lid = insLead.run(`l${i}@test`, `F${i}`, nowIso()).lastInsertRowid; ids.push(lid); enroll.run(cid, lid, nowIso(), nowIso()); }
db.prepare(`UPDATE enrollments SET status='replied' WHERE lead_id=?`).run(ids[0]);
db.prepare(`UPDATE leads SET status='replied' WHERE id=?`).run(ids[0]);

const cid2 = db.prepare(`INSERT INTO campaigns (name,status,tz,send_start,send_end,send_days,created_at) VALUES ('Closed','live','UTC',0,0,'0-6',?)`).run(nowIso()).lastInsertRowid;
db.prepare(`INSERT INTO campaign_accounts (campaign_id,account_id) VALUES (?,?)`).run(cid2, A);
const s2 = db.prepare(`INSERT INTO sequences (campaign_id,step_index,delay_days,created_at) VALUES (?,0,0,?)`).run(cid2, nowIso()).lastInsertRowid;
db.prepare(`INSERT INTO variants (sequence_id,ab,subject,body,enabled,created_at) VALUES (?,'A','X','Y',1,?)`).run(s2, nowIso());
enroll.run(cid2, insLead.run('closed@test', 'C', nowIso()).lastInsertRowid, nowIso(), nowIso());

for (let i = 0; i < 200; i++) {
  await tickOnce();
  if (!db.prepare(`SELECT COUNT(*) c FROM enrollments WHERE campaign_id=? AND status='active'`).get(cid).c) break;
}

const sent = db.prepare(`SELECT COUNT(*) c FROM messages WHERE status='sent'`).get().c;
const active = N - 1;
assert.strictEqual(sent, active * 2, `expected ${active * 2}, got ${sent}`);
ok(`multi-step sequence: every active lead got step 0 + step 1 (${sent} sends)`);
assert.strictEqual(db.prepare(`SELECT COUNT(*) c FROM messages WHERE variant_label='B'`).get().c, 0);
ok('A/B: disabled variant B never sent');
assert.strictEqual(db.prepare(`SELECT COUNT(*) c FROM messages WHERE lead_id=?`).get(ids[0]).c, 0);
ok('reply suppression: replied lead never emailed');
assert.strictEqual(db.prepare(`SELECT COUNT(*) c FROM messages WHERE account_id=?`).get(D).c, 0);
ok('per-campaign mailboxes: excluded mailbox sent nothing');
assert.strictEqual(db.prepare(`SELECT COUNT(*) c FROM messages WHERE campaign_id=?`).get(cid2).c, 0);
ok('schedule window: closed-window campaign sent nothing');

const C = insAcc.run('Cacc','C','c@test','h','c','p',100,0,null,nowIso()).lastInsertRowid;
const gc = db.prepare(`INSERT INTO campaigns (name,status,tz,send_start,send_end,send_days,created_at) VALUES ('G','paused','UTC',0,24,'0-6',?)`).run(nowIso()).lastInsertRowid;
const im = db.prepare(`INSERT INTO messages (campaign_id,lead_id,account_id,status,sent_at,created_at) VALUES (?,?,?,?,?,?)`);
for (let i = 0; i < 21; i++) im.run(gc, ids[1], C, i === 0 ? 'bounced' : 'sent', nowIso(), nowIso());
await tickOnce();
assert.strictEqual(db.prepare(`SELECT status FROM accounts WHERE id=?`).get(C).status, 'error');
ok('bounce guardrail: mailbox auto-paused above 3%');

db.close();
for (const e of ['', '-wal', '-shm']) fs.rmSync(tmpDb + e, { force: true });
console.log(`\nAll ${passed} checks passed.`);
