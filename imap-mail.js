// SMTP + IMAP connection (works with any provider, no Google review needed)
const { ImapFlow } = require('imapflow');
const nodemailer = require('nodemailer');
const { simpleParser } = require('mailparser');

const PROVIDERS = {
  gmail:   { imap: { host: 'imap.gmail.com', port: 993 },            smtp: { host: 'smtp.gmail.com', port: 465, secure: true } },
  outlook: { imap: { host: 'outlook.office365.com', port: 993 },     smtp: { host: 'smtp-mail.outlook.com', port: 587, secure: false } },
  yahoo:   { imap: { host: 'imap.mail.yahoo.com', port: 993 },       smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true } },
  zoho:    { imap: { host: 'imap.zoho.com', port: 993 },             smtp: { host: 'smtp.zoho.com', port: 465, secure: true } },
};

function buildConfig({ email, password, provider, imapHost, imapPort, smtpHost, smtpPort }) {
  const p = PROVIDERS[provider];
  if (!p && provider !== 'custom') throw new Error('Unknown provider');
  const imap = p ? p.imap : { host: imapHost, port: Number(imapPort) || 993 };
  const smtp = p ? p.smtp : { host: smtpHost, port: Number(smtpPort) || 465, secure: (Number(smtpPort) || 465) === 465 };
  if (!imap.host || !smtp.host) throw new Error('Mail server details are required');
  return { email, password, imap, smtp };
}

const imapClient = (cfg) => new ImapFlow({
  host: cfg.imap.host,
  port: cfg.imap.port,
  secure: true,
  auth: { user: cfg.email, pass: cfg.password },
  logger: false,
});

const smtpTransport = (cfg) => nodemailer.createTransport({
  host: cfg.smtp.host,
  port: cfg.smtp.port,
  secure: cfg.smtp.secure,
  auth: { user: cfg.email, pass: cfg.password },
});

async function verify(cfg) {
  const c = imapClient(cfg);
  try { await c.connect(); } finally { try { await c.logout(); } catch {} }
  await smtpTransport(cfg).verify();
}

async function listInbox(cfg, limit = 15) {
  const c = imapClient(cfg);
  await c.connect();
  const lock = await c.getMailboxLock('INBOX');
  try {
    const total = c.mailbox.exists;
    if (!total) return [];
    const from = Math.max(1, total - limit + 1);
    const out = [];
    for await (const m of c.fetch(`${from}:*`, { uid: true, envelope: true })) {
      const f = m.envelope.from && m.envelope.from[0];
      out.push({
        id: String(m.uid),
        from: f ? (f.name ? `${f.name} <${f.address}>` : f.address) : '',
        subject: m.envelope.subject || '(no subject)',
        date: m.envelope.date ? new Date(m.envelope.date).toString() : '',
        snippet: '',
      });
    }
    return out.reverse();
  } finally {
    lock.release();
    try { await c.logout(); } catch {}
  }
}

async function readMessage(cfg, uid) {
  const c = imapClient(cfg);
  await c.connect();
  const lock = await c.getMailboxLock('INBOX');
  try {
    const msg = await c.fetchOne(String(uid), { source: true }, { uid: true });
    if (!msg || !msg.source) throw new Error('Message not found');
    const p = await simpleParser(msg.source);
    return {
      id: String(uid),
      from: p.from ? p.from.text : '',
      to: p.to ? p.to.text : '',
      subject: p.subject || '',
      date: p.date ? p.date.toString() : '',
      body: p.text || (p.html ? p.html.replace(/<[^>]+>/g, ' ') : '') || '(empty message)',
    };
  } finally {
    lock.release();
    try { await c.logout(); } catch {}
  }
}

async function sendMessage(cfg, { to, subject, body }) {
  await smtpTransport(cfg).sendMail({ from: cfg.email, to, subject, text: body || '' });
}

module.exports = { PROVIDERS, buildConfig, verify, listInbox, readMessage, sendMessage };