require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');
const path = require('path');
const mail = require('./imap-mail');

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  REDIRECT_URI = 'http://localhost:3000/auth/google/callback',
  SESSION_SECRET = 'dev-secret',
  PORT = 3000,
} = process.env;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error('Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env');
  process.exit(1);
}

const SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
];

const app = express();
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax' },
}));
app.use(express.static(path.join(__dirname, 'public')));

const newClient = () => new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);

function authedClient(req) {
  if (!req.session.tokens) return null;
  const c = newClient();
  c.setCredentials(req.session.tokens);
  // keep refreshed tokens in the session
  c.on('tokens', (t) => { req.session.tokens = { ...req.session.tokens, ...t }; });
  return c;
}

function requireAuth(req, res, next) {
  // Connected with an app password (SMTP/IMAP)? Use that instead of Google.
  if (req.session.imap) { req.imap = req.session.imap; return next(); }
  const client = authedClient(req);
  if (!client) return res.status(401).json({ error: 'Not connected' });
  req.gclient = client;
  next();
}

// ---------- Step 1: onboarding form data (what the user fills in) ----------
app.post('/api/onboard', (req, res) => {
  const { fullName, company, email } = req.body || {};
  if (!fullName || !company) return res.status(400).json({ error: 'Name and company are required' });
  req.session.profile = { fullName, company, hint: email || '' };
  res.json({ ok: true });
});

// ---------- Step 2: Google OAuth ----------
app.get('/auth/google', (req, res) => {
  const url = newClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    login_hint: req.session.profile?.hint || undefined,
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const client = newClient();
    const { tokens } = await client.getToken(req.query.code);
    client.setCredentials(tokens);
    const { data } = await google.oauth2({ version: 'v2', auth: client }).userinfo.get();
    req.session.tokens = tokens;
    req.session.user = { email: data.email, name: data.name, picture: data.picture };
    res.redirect('/?connected=1');
  } catch (e) {
    console.error(e);
    res.redirect('/?error=auth_failed');
  }
});

app.post('/auth/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

// ---------- Alternative: connect any mailbox with SMTP + IMAP (app password) ----------
app.post('/api/imap/connect', async (req, res) => {
  const { email, password, provider } = req.body || {};
  if (!email || !password || !provider) return res.status(400).json({ error: 'Email, app password and provider are required' });
  try {
    const cfg = mail.buildConfig({ ...req.body, password: String(password).replace(/\s+/g, '') });
    await mail.verify(cfg);
    req.session.imap = cfg;
    req.session.user = { email, name: req.session.profile?.fullName || email, picture: '' };
    res.json({ ok: true });
  } catch (e) {
    console.error('IMAP connect failed:', e.message);
    res.status(401).json({ error: 'Could not sign in. Check the email, app password and provider.' });
  }
});

app.get('/api/me', (req, res) => {
  res.json({
    mode: req.session.imap ? 'imap' : (req.session.tokens ? 'google' : null),
    connected: !!(req.session.tokens || req.session.imap),
    user: req.session.user || null,
    profile: req.session.profile || null,
  });
});

// ---------- Email: inbox + read + send ----------
const header = (headers, name) => (headers.find((h) => h.name.toLowerCase() === name) || {}).value || '';

app.get('/api/emails', requireAuth, async (req, res) => {
  try {
    if (req.imap) return res.json(await mail.listInbox(req.imap));
    const gmail = google.gmail({ version: 'v1', auth: req.gclient });
    const list = await gmail.users.messages.list({ userId: 'me', maxResults: 15, labelIds: ['INBOX'] });
    const ids = (list.data.messages || []).map((m) => m.id);
    const msgs = await Promise.all(ids.map((id) =>
      gmail.users.messages.get({
        userId: 'me', id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'],
      })));
    res.json(msgs.map(({ data }) => ({
      id: data.id,
      from: header(data.payload.headers, 'from'),
      subject: header(data.payload.headers, 'subject') || '(no subject)',
      date: header(data.payload.headers, 'date'),
      snippet: data.snippet,
    })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load emails' });
  }
});

function extractBody(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  }
  for (const part of payload.parts || []) {
    const t = extractBody(part);
    if (t) return t;
  }
  return '';
}

app.get('/api/emails/:id', requireAuth, async (req, res) => {
  try {
    if (req.imap) return res.json(await mail.readMessage(req.imap, req.params.id));
    const gmail = google.gmail({ version: 'v1', auth: req.gclient });
    const { data } = await gmail.users.messages.get({ userId: 'me', id: req.params.id, format: 'full' });
    res.json({
      id: data.id,
      from: header(data.payload.headers, 'from'),
      to: header(data.payload.headers, 'to'),
      subject: header(data.payload.headers, 'subject'),
      date: header(data.payload.headers, 'date'),
      body: extractBody(data.payload) || data.snippet,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load email' });
  }
});

app.post('/api/emails/send', requireAuth, async (req, res) => {
  const { to, subject, body } = req.body || {};
  if (!to || !subject) return res.status(400).json({ error: 'To and subject are required' });
  if (/[\r\n]/.test(to + subject)) return res.status(400).json({ error: 'Invalid header characters' });
  try {
    if (req.imap) {
      await mail.sendMessage(req.imap, { to, subject, body });
      return res.json({ ok: true });
    }
    const gmail = google.gmail({ version: 'v1', auth: req.gclient });
    const raw = [
      `To: ${to}`,
      `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      body || '',
    ].join('\r\n');
    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: Buffer.from(raw).toString('base64url') },
    });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not send email' });
  }
});

// ---------- Chat integration sample (in-memory, polling) ----------
const chatMessages = []; // { id, name, text, ts }
let chatSeq = 0;

app.get('/api/chat', (req, res) => {
  const since = Number(req.query.since || 0);
  res.json(chatMessages.filter((m) => m.id > since));
});

app.post('/api/chat', (req, res) => {
  const text = String(req.body?.text || '').trim().slice(0, 1000);
  if (!text) return res.status(400).json({ error: 'Empty message' });
  const name = req.session.user?.name || req.session.profile?.fullName || 'Guest';
  const msg = { id: ++chatSeq, name, text, ts: Date.now() };
  chatMessages.push(msg);
  if (chatMessages.length > 200) chatMessages.shift();
  res.json(msg);
});

app.listen(PORT, () => console.log(`Demo running at http://localhost:${PORT}`));