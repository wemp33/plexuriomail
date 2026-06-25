// nodemailer wrapper. DRY_RUN uses a no-network jsonTransport.
// No open tracking, no unsubscribe headers — by design.
import nodemailer from 'nodemailer';

const DRY_RUN = process.env.DRY_RUN !== '0';
export function isDryRun() { return DRY_RUN; }

function buildTransport(acc) {
  if (DRY_RUN) return nodemailer.createTransport({ jsonTransport: true });
  return nodemailer.createTransport({
    host: acc.smtp_host, port: Number(acc.smtp_port), secure: !!acc.smtp_secure,
    auth: { user: acc.smtp_user, pass: acc.smtp_pass },
    connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 20000,
  });
}
export async function verifyAccount(acc) { if (DRY_RUN) return true; await buildTransport(acc).verify(); return true; }
function fromHeader(acc) { return acc.from_name ? `"${acc.from_name}" <${acc.from_email}>` : acc.from_email; }

export async function sendEmail(acc, { to, subject, text, html, headers }) {
  const info = await buildTransport(acc).sendMail({ from: fromHeader(acc), to, subject, text, html, headers });
  return {
    messageId: info.messageId,
    preview: nodemailer.getTestMessageUrl?.(info) || null,
    accepted: info.accepted || [],
    rejected: info.rejected || [],
  };
}
