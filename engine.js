// PlexurioMail engine: drives multi-step sequences with A/B variants, sends only
// from each campaign's selected mailboxes, respects per-campaign schedules, runs a
// warmup simulator, and enforces throttling + bounce-rate guardrails.
import { db, nowIso, sentTodayCount, warmupTodayCount, effectiveDailyCap, warmupTarget, accountBounceStats } from './db.js';
import { sendEmail } from './mailer.js';
import { stepWarmup } from './warmup.js';

const BOUNCE_PAUSE_RATE = Number(process.env.BOUNCE_PAUSE_RATE || 0.03);
const BOUNCE_MIN_SAMPLE = Number(process.env.BOUNCE_MIN_SAMPLE || 20);
const WARMUP_MIN_GAP = Number(process.env.WARMUP_MIN_GAP || 3);
const WARMUP_MAX_GAP = Number(process.env.WARMUP_MAX_GAP || 9);

let timer = null, running = true, ticking = false, lastTickAt = null;
const randInt = (a, b) => Math.floor(a + Math.random() * (b - a + 1));

export function renderTemplate(tpl, lead) {
  const map = {
    first_name: lead.first_name, last_name: lead.last_name, company: lead.company, email: lead.email,
    per1: lead.per1, per2: lead.per2, per3: lead.per3, per4: lead.per4, per5: lead.per5,
  };
  return String(tpl || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => { const v = map[k]; return v == null ? '' : String(v); });
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function textToHtml(t) { return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;white-space:pre-wrap">${escapeHtml(t)}</div>`; }

function dayAllowed(day, spec) {
  for (const part of String(spec).split(',')) {
    const m = part.trim().match(/^(\d)\s*-\s*(\d)$/);
    if (m) { if (day >= +m[1] && day <= +m[2]) return true; }
    else if (part.trim() !== '' && +part.trim() === day) return true;
  }
  return false;
}
function nowInTz(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', hour12: false, weekday: 'short', hour: '2-digit' }).formatToParts(new Date());
    const hour = Number(parts.find((p) => p.type === 'hour').value) % 24;
    const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return { hour, day: map[parts.find((p) => p.type === 'weekday').value] ?? new Date().getDay() };
  } catch { const d = new Date(); return { hour: d.getHours(), day: d.getDay() }; }
}
export function campaignWindowOpen(c) {
  const { hour, day } = nowInTz(c.tz);
  return dayAllowed(day, c.send_days) && hour >= c.send_start && hour < c.send_end;
}

export function recoverStuck() {} // enrollments are self-healing; nothing to reset

function openLiveCampaignIds() {
  return db.prepare(`SELECT * FROM campaigns WHERE status='live'`).all().filter(campaignWindowOpen).map((c) => c.id);
}
function nextEnrollmentFor(acc, openIds) {
  if (!openIds.length) return null;
  const ph = openIds.map(() => '?').join(',');
  return db.prepare(
    `SELECT e.* FROM enrollments e
     JOIN campaign_accounts ca ON ca.campaign_id=e.campaign_id AND ca.account_id=?
     JOIN leads l ON l.id=e.lead_id
     WHERE e.status='active' AND l.status='active' AND e.campaign_id IN (${ph})
       AND (e.account_id IS NULL OR e.account_id=?)
       AND (e.next_due_at IS NULL OR e.next_due_at<=?)
     ORDER BY (e.next_due_at IS NULL) DESC, e.next_due_at ASC, e.id ASC LIMIT 1`
  ).get(acc.id, ...openIds, acc.id, nowIso());
}
function pickVariant(sequenceId) {
  const vs = db.prepare(`SELECT * FROM variants WHERE sequence_id=? AND enabled=1`).all(sequenceId).filter((v) => (v.subject || v.body));
  return vs.length ? vs[Math.floor(Math.random() * vs.length)] : null;
}


function advance(enr, acc) {
  const next = db.prepare(`SELECT * FROM sequences WHERE campaign_id=? AND step_index=?`).get(enr.campaign_id, enr.current_step + 1);
  if (next) {
    const due = new Date(Date.now() + (next.delay_days || 0) * 86400000).toISOString();
    db.prepare(`UPDATE enrollments SET current_step=?, next_due_at=?, account_id=? WHERE id=?`).run(enr.current_step + 1, due, acc.id, enr.id);
  } else {
    db.prepare(`UPDATE enrollments SET status='done', account_id=? WHERE id=?`).run(acc.id, enr.id);
  }
}

async function sendOneFor(acc, openIds) {
  const enr = nextEnrollmentFor(acc, openIds);
  if (!enr) return false;
  const lead = db.prepare(`SELECT * FROM leads WHERE id=?`).get(enr.lead_id);
  const seq = db.prepare(`SELECT * FROM sequences WHERE campaign_id=? AND step_index=?`).get(enr.campaign_id, enr.current_step);
  if (!seq) { db.prepare(`UPDATE enrollments SET status='done' WHERE id=?`).run(enr.id); return false; }
  const variant = pickVariant(seq.id);
  if (!variant) { db.prepare(`UPDATE enrollments SET status='done' WHERE id=?`).run(enr.id); return false; }

  const subject = renderTemplate(variant.subject, lead);
  const text = renderTemplate(variant.body, lead);
  // claim so a parallel tick can't double-send
  const claim = db.prepare(`UPDATE enrollments SET account_id=? WHERE id=? AND status='active'`).run(acc.id, enr.id);
  if (claim.changes === 0) return false;

  try {
    const res = await sendEmail(acc, { to: lead.email, subject, text, html: textToHtml(text) });
    const hardBounce = res.rejected?.length && !(res.accepted?.length);
    const status = hardBounce ? 'bounced' : 'sent';
    db.prepare(`INSERT INTO messages (campaign_id,lead_id,account_id,step_index,variant_label,status,subject,body,preview_url,sent_at,created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(enr.campaign_id, lead.id, acc.id, enr.current_step, variant.ab, status, subject, text, res.preview || null, nowIso(), nowIso());
    if (hardBounce) {
      db.prepare(`UPDATE leads SET status='bounced', last_event_at=? WHERE id=?`).run(nowIso(), lead.id);
      db.prepare(`UPDATE enrollments SET status='bounced' WHERE id=?`).run(enr.id);
      console.warn(`[engine] BOUNCE step ${enr.current_step}+${variant.ab} via "${acc.name}" -> ${lead.email}`);
    } else {
      advance(enr, acc);
      console.log(`[engine] sent step ${enr.current_step} variant ${variant.ab} via "${acc.name}" -> ${lead.email}`);
    }
    const next = new Date(Date.now() + randInt(acc.min_gap_seconds, acc.max_gap_seconds) * 1000).toISOString();
    db.prepare(`UPDATE accounts SET last_sent_at=?, next_due_at=?, last_error=NULL WHERE id=?`).run(nowIso(), next, acc.id);
  } catch (err) {
    const message = String(err?.message || err);
    db.prepare(`INSERT INTO messages (campaign_id,lead_id,account_id,step_index,variant_label,status,subject,body,error,sent_at,created_at)
                VALUES (?,?,?,?,?,'failed',?,?,?,?,?)`)
      .run(enr.campaign_id, lead.id, acc.id, enr.current_step, variant.ab, subject, text, message, nowIso(), nowIso());
    db.prepare(`UPDATE accounts SET last_error=? WHERE id=?`).run(message, acc.id);
    console.warn(`[engine] FAILED via "${acc.name}": ${message}`);
  }
  return true;
}

export async function tickOnce() {
  if (ticking) return;
  ticking = true; lastTickAt = nowIso();
  try {
    const openIds = openLiveCampaignIds();
    for (const acc of db.prepare(`SELECT * FROM accounts WHERE status='active'`).all()) {
      const bs = accountBounceStats(acc.id);
      if (bs.sent >= BOUNCE_MIN_SAMPLE && bs.rate > BOUNCE_PAUSE_RATE) {
        db.prepare(`UPDATE accounts SET status='error', last_error=? WHERE id=?`)
          .run(`Auto-paused: bounce rate ${(bs.rate * 100).toFixed(1)}% over ${bs.sent} sends. Clean the list, then resume.`, acc.id);
        continue;
      }
      await stepWarmup(acc);
      if (acc.next_due_at && Date.parse(acc.next_due_at) > Date.now()) continue;
      if (sentTodayCount(acc.id) >= effectiveDailyCap(acc)) continue;
      await sendOneFor(acc, openIds);
    }
  } finally { ticking = false; }
}

export function startEngine(intervalMs = 4000) {
  if (timer) return;
  timer = setInterval(() => { if (running) tickOnce().catch((e) => console.error('[engine] tick error:', e)); }, intervalMs);
  console.log(`[engine] started (tick every ${intervalMs}ms, ${running ? 'running' : 'paused'})`);
}
export function pauseEngine() { running = false; }
export function resumeEngine() { running = true; }
export function engineState() { return { running, lastTickAt }; }
