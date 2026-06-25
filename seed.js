// Demo data for PlexurioMail (Instantly-style). Great with DRY_RUN=1.  node src/seed.js
import 'dotenv/config';
import { db, nowIso } from './db.js';

console.log('Seeding demo data…');
db.exec(`DELETE FROM replies; DELETE FROM warmup_log; DELETE FROM messages; DELETE FROM enrollments;
         DELETE FROM variants; DELETE FROM sequences; DELETE FROM campaign_accounts; DELETE FROM campaigns;
         DELETE FROM leads; DELETE FROM accounts;`);

const insAcc = db.prepare(`INSERT INTO accounts
  (name,from_name,from_email,smtp_host,smtp_port,smtp_secure,smtp_user,smtp_pass,
   imap_host,imap_port,imap_secure,imap_user,imap_pass,daily_limit,min_gap_seconds,max_gap_seconds,
   warmup_enabled,warmup_initial,warmup_increment,warmup_target,warmup_started_at,status,created_at)
  VALUES (@name,@from_name,@from_email,@smtp_host,587,0,@smtp_user,'dry-run',
   @imap_host,993,1,@imap_user,'dry-run',@daily_limit,2,4,
   @warmup_enabled,5,5,30,@warmup_started_at,'active',@created_at)`);

const A = insAcc.run({ name:'Amelia — Sales', from_name:'Amelia', from_email:'amelia@demo.test',
  smtp_host:'smtp.example.com', smtp_user:'amelia@demo.test', imap_host:'imap.example.com', imap_user:'amelia@demo.test',
  daily_limit:50, warmup_enabled:1, warmup_started_at:nowIso(), created_at:nowIso() }).lastInsertRowid;
const S = insAcc.run({ name:'Sam — Founder', from_name:'Sam Lee', from_email:'sam@demo.test',
  smtp_host:'smtp.example.com', smtp_user:'sam@demo.test', imap_host:'imap.example.com', imap_user:'sam@demo.test',
  daily_limit:30, warmup_enabled:1, warmup_started_at:nowIso(), created_at:nowIso() }).lastInsertRowid;

const cid = db.prepare(`INSERT INTO campaigns (name,status,tz,send_start,send_end,send_days,created_at)
  VALUES ('June outreach','live','UTC',0,24,'0-6',?)`).run(nowIso()).lastInsertRowid;
db.prepare(`INSERT INTO campaign_accounts (campaign_id,account_id) VALUES (?,?)`).run(cid, A);
db.prepare(`INSERT INTO campaign_accounts (campaign_id,account_id) VALUES (?,?)`).run(cid, S);

// Sequence: step 0 (first email, A/B) + step 1 (follow-up after 3 days)
const s0 = db.prepare(`INSERT INTO sequences (campaign_id,step_index,delay_days,created_at) VALUES (?,?,?,?)`).run(cid,0,0,nowIso()).lastInsertRowid;
db.prepare(`INSERT INTO variants (sequence_id,ab,subject,body,enabled,created_at) VALUES (?,?,?,?,1,?)`).run(
  s0,'A','Quick question about {{company}}, {{first_name}}',
  'Hi {{first_name}},\n\nI saw {{per1}} — really impressive. I had a quick idea for {{company}} I think could help.\nWorth a 10-minute chat this week?\n\nBest,\nAmelia', nowIso());
db.prepare(`INSERT INTO variants (sequence_id,ab,subject,body,enabled,created_at) VALUES (?,?,?,?,0,?)`).run(
  s0,'B','{{first_name}}, an idea for {{company}}',
  'Hi {{first_name}},\n\n{{per1}} caught my eye. Quick idea for {{company}} — open to a chat?\n\nAmelia', nowIso());
const s1 = db.prepare(`INSERT INTO sequences (campaign_id,step_index,delay_days,created_at) VALUES (?,?,?,?)`).run(cid,1,3,nowIso()).lastInsertRowid;
db.prepare(`INSERT INTO variants (sequence_id,ab,subject,body,enabled,created_at) VALUES (?,?,?,?,1,?)`).run(
  s1,'A','Re: {{company}}','Just bumping this up, {{first_name}} — any thoughts?\n\nAmelia', nowIso());
db.prepare(`INSERT INTO variants (sequence_id,ab,subject,body,enabled,created_at) VALUES (?,?,?,?,0,?)`).run(s1,'B','','', nowIso());

const leads = [
  ['amir@northwind.test','Amir','Khan','Northwind','your post on supply-chain AI'],
  ['bea@globex.test','Bea','Ortiz','Globex','the Globex Series B'],
  ['carl@initech.test','Carl','Reyes','Initech','your talk at SaaStr'],
  ['dana@umbrella.test','Dana','Wu','Umbrella','the new Umbrella HQ'],
  ['ed@hooli.test','Ed','Park','Hooli','your hiring spree'],
  ['fiona@acme.test','Fiona','Ali','Acme','Acme launching in EU'],
  ['gabe@stark.test','Gabe','Nwosu','Stark','your keynote'],
  ['hana@wayne.test','Hana','Cohen','Wayne','the Wayne Foundation'],
  ['ivan@soylent.test','Ivan','Petrov','Soylent','your podcast episode'],
  ['jo@piedpiper.test','Jo','Tanaka','Pied Piper','the compression demo'],
  ['kira@cyberdyne.test','Kira','Mbeki','Cyberdyne','your robotics roadmap'],
  ['leo@tyrell.test','Leo','Santos','Tyrell','the Nexus product line'],
];
const insLead = db.prepare(`INSERT INTO leads (email,first_name,last_name,company,per1,status,created_at) VALUES (?,?,?,?,?, 'active', ?)`);
const enroll = db.prepare(`INSERT INTO enrollments (campaign_id,lead_id,current_step,next_due_at,status,created_at) VALUES (?,?,0,?, 'active', ?)`);
const ids = leads.map((l) => { const lid = insLead.run(l[0],l[1],l[2],l[3],l[4],nowIso()).lastInsertRowid; enroll.run(cid, lid, nowIso(), nowIso()); return lid; });

// Two demo replies (so the inbox + reply-rate analytics show data in dry-run)
const reply = db.prepare(`INSERT INTO replies (account_id,lead_id,from_email,subject,snippet,received_at,read,created_at) VALUES (?,?,?,?,?,?,0,?)`);
for (const [idx, subj, snip] of [[0,'Re: Quick question about Northwind, Amir','Sure, sounds interesting — how does Tuesday 2pm look?'],[2,'Re: your talk at SaaStr','Thanks Amelia, can you send a one-pager first?']]) {
  const lid = ids[idx];
  db.prepare(`UPDATE leads SET status='replied', last_event_at=? WHERE id=?`).run(nowIso(), lid);
  db.prepare(`UPDATE enrollments SET status='replied' WHERE lead_id=?`).run(lid);
  reply.run(A, lid, leads[idx][0], subj, snip, nowIso(), nowIso());
}

console.log(`Seeded 2 mailboxes (1 warming), 1 live campaign, a 2-step A/B sequence, ${leads.length} leads, 2 replies.`);
console.log('Start with: npm start');
