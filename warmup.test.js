// Verifies the peer-to-peer warmup system (dry-run simulation):
// warming mailboxes exchange mail, counts ramp to the daily target, a non-warming
// mailbox does nothing, and received/replied/rescued activity is recorded.
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.DRY_RUN = '1';
process.env.WARMUP_MIN_GAP = '0';
process.env.WARMUP_MAX_GAP = '0';
const tmpDb = path.join(os.tmpdir(), `plexw-${Date.now()}.db`);
process.env.DB_PATH = tmpDb;

const { db, nowIso, warmupTodayCount, warmupStats } = await import('../src/db.js');
const { tickOnce } = await import('../src/engine.js');
let passed = 0; const ok = (m) => { console.log('  ✓ ' + m); passed++; };

const insAcc = db.prepare(`INSERT INTO accounts (name,from_name,from_email,smtp_host,smtp_port,smtp_secure,smtp_user,smtp_pass,
  daily_limit,min_gap_seconds,max_gap_seconds,warmup_enabled,warmup_initial,warmup_increment,warmup_target,warmup_started_at,status,created_at)
  VALUES (?,?,?,?,587,0,?,?,30,0,0,?,5,5,30,?,'active',?)`);
const P = insAcc.run('P','P','p@test','h','p','x',1,nowIso(),nowIso()).lastInsertRowid; // warming
const Q = insAcc.run('Q','Q','q@test','h','q','x',1,nowIso(),nowIso()).lastInsertRowid; // warming
const R = insAcc.run('R','R','r@test','h','r','x',0,null,nowIso()).lastInsertRowid;       // not warming

for (let i = 0; i < 30; i++) await tickOnce();

assert.strictEqual(warmupTodayCount(P), 5, `P sent ${warmupTodayCount(P)}, expected ramp target 5`);
assert.strictEqual(warmupTodayCount(Q), 5, `Q sent ${warmupTodayCount(Q)}, expected 5`);
ok('warming mailboxes ramp to the daily target (5/day on day one)');
assert.strictEqual(warmupTodayCount(R), 0);
ok('non-warming mailbox sends no warmup');
const sp = warmupStats(P);
assert.ok(sp.received > 0, `P received ${sp.received}, expected > 0 (Q warms P back)`);
ok(`two-way exchange recorded (P: sent ${sp.sent}, received ${sp.received}, replied ${sp.replied}, rescued ${sp.rescued})`);
assert.strictEqual(warmupStats(R).received, 0);
ok('non-warming mailbox receives nothing');

db.close();
for (const e of ['', '-wal', '-shm']) fs.rmSync(tmpDb + e, { force: true });
console.log(`\nAll ${passed} warmup checks passed.`);
