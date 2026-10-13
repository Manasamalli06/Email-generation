require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns').promises;

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

// Every connected email account is attached to a role (like choosing an inbox in Front),
// so HR mail goes out from the HR address, accounts mail from the accounts address, etc.
const ROLES = [
  { id: 'owner',    label: 'Owner',    desc: 'Leadership and company-wide email' },
  { id: 'hr',       label: 'HR',       desc: 'Hiring, offers and employee communication' },
  { id: 'accounts', label: 'Accounts', desc: 'Invoices, payments and finance email' },
];
const ROLE_IDS = ROLES.map((r) => r.id);
const roleLabel = (id) => (ROLES.find((r) => r.id === id) || {}).label || id;

// Pages a user may be sent back to after Google sign-in (prevents open redirects).
const RETURN_PAGES = ['/', '/index.html'];

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

const ID_PATTERN = /^[a-f0-9]{10}$/;
const accountIdFor = (email) => crypto.createHash('sha1').update(email.toLowerCase()).digest('hex').slice(0, 10);
const accountOf = (req, id) => {
  const all = req.session.accounts;
  return all && ID_PATTERN.test(id) && Object.prototype.hasOwnProperty.call(all, id) ? all[id] : null;
};

function clientFor(req, id) {
  const acct = accountOf(req, id);
  if (!acct) return null;
  const c = newClient();
  c.setCredentials(acct.tokens);
  // keep refreshed tokens in the session
  c.on('tokens', (t) => { acct.tokens = { ...acct.tokens, ...t }; });
  return c;
}

// Every email route needs ?account=<id> (or in the JSON body) and that account must be connected.
function requireAccount(req, res, next) {
  const id = String(req.query.account || (req.body && req.body.account) || '');
  const client = clientFor(req, id);
  if (!client) return res.status(401).json({ error: 'This email account is not connected' });
  req.accountId = id;
  req.gclient = client;
  next();
}

// ---------- Connected accounts ----------
app.get('/api/accounts', (req, res) => {
  const all = req.session.accounts || {};
  res.json({
    roles: ROLES,
    accounts: Object.keys(all).map((id) => ({
      id,
      email: all[id].user.email,
      name: all[id].user.name,
      picture: all[id].user.picture,
      role: all[id].role,
      roleLabel: roleLabel(all[id].role),
      provider: 'Gmail',
    })),
  });
});

app.post('/api/accounts/:id/disconnect', (req, res) => {
  if (!ID_PATTERN.test(req.params.id)) return res.status(400).json({ error: 'Unknown account' });
  if (req.session.accounts) delete req.session.accounts[req.params.id];
  res.json({ ok: true });
});

app.post('/auth/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

// ---------- Step 1 of the connect dialog: detect the email provider ----------
app.get('/api/detect', async (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address' });
  }
  const domain = email.split('@')[1];
  if (domain === 'gmail.com' || domain === 'googlemail.com') return res.json({ provider: 'google' });
  try {
    // Company addresses on Google Workspace or Microsoft 365 are recognised by their mail servers.
    const mx = await dns.resolveMx(domain);
    const hosts = mx.map((m) => m.exchange.toLowerCase().replace(/\.$/, ''));
    const under = (h, d) => h === d || h.endsWith('.' + d);
    if (hosts.some((h) => under(h, 'google.com') || under(h, 'googlemail.com'))) return res.json({ provider: 'google' });
    if (hosts.some((h) => under(h, 'outlook.com') || under(h, 'office365.com'))) return res.json({ provider: 'microsoft' });
    res.json({ provider: 'other' });
  } catch {
    res.json({ provider: 'unknown' });
  }
});

// ---------- Step 2: Google OAuth (one sign-in per account) ----------
app.get('/auth/google', (req, res) => {
  const role = String(req.query.role || '');
  if (!ROLE_IDS.includes(role)) return res.status(400).send('Unknown role');
  const from = RETURN_PAGES.includes(req.query.from) ? req.query.from : '/';
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauth = { state, role, from };
  const hint = typeof req.query.hint === 'string' ? req.query.hint.trim().slice(0, 200) : '';
  const url = newClient().generateAuthUrl({
    access_type: 'offline',
    // With an email typed in, Google opens on that account; without one, show the account picker.
    prompt: hint ? 'consent' : 'select_account consent',
    scope: SCOPES,
    state,
    login_hint: hint || undefined,
  });
  req.session.save(() => res.redirect(url));
});

app.get('/auth/google/callback', async (req, res) => {
  const o = req.session.oauth;
  delete req.session.oauth;
  const back = (o && o.from) || '/';
  if (req.query.error) return res.redirect(`${back}?error=${encodeURIComponent(String(req.query.error))}`);
  if (!o || req.query.state !== o.state) return res.redirect(`${back}?error=state_mismatch`);
  try {
    const client = newClient();
    const { tokens } = await client.getToken(String(req.query.code));
    client.setCredentials(tokens);
    const { data } = await google.oauth2({ version: 'v2', auth: client }).userinfo.get();
    const id = accountIdFor(data.email);
    req.session.accounts = req.session.accounts || {};
    const previous = req.session.accounts[id];
    req.session.accounts[id] = {
      role: o.role,
      // Google only sends a refresh token on first consent; keep the old one if this sign-in has none.
      tokens: { ...(previous ? previous.tokens : {}), ...tokens },
      user: { email: data.email, name: data.name, picture: data.picture },
    };
    req.session.save(() => res.redirect(`${back}?connected=${id}`));
  } catch (e) {
    console.error(e);
    res.redirect(`${back}?error=auth_failed`);
  }
});

// ---------- Email: inbox + read + send (always for one chosen account) ----------
const header = (headers, name) => (headers.find((h) => h.name.toLowerCase() === name) || {}).value || '';

function apiError(e, fallback) {
  const reason = e && e.errors && e.errors[0] && e.errors[0].reason;
  if (reason === 'accessNotConfigured') return 'The Gmail API is not enabled for this Google project.';
  if (e && (e.code === 401 || e.status === 401)) return 'Google access expired. Disconnect and connect this account again.';
  return fallback;
}

app.get('/api/emails', requireAccount, async (req, res) => {
  try {
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
    res.status(500).json({ error: apiError(e, 'Could not load emails') });
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

app.get('/api/emails/:id', requireAccount, async (req, res) => {
  try {
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
    res.status(500).json({ error: apiError(e, 'Could not load email') });
  }
});

app.post('/api/emails/send', requireAccount, async (req, res) => {
  const { to, subject, body } = req.body || {};
  if (!to || !subject) return res.status(400).json({ error: 'To and subject are required' });
  if (/[\r\n]/.test(to + subject)) return res.status(400).json({ error: 'Invalid header characters' });
  try {
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
    res.json({ ok: true, from: accountOf(req, req.accountId).user.email });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: apiError(e, 'Could not send email') });
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
  const first = Object.values(req.session.accounts || {})[0];
  const name = (first && first.user.name) || 'Guest';
  const msg = { id: ++chatSeq, name, text, ts: Date.now() };
  chatMessages.push(msg);
  if (chatMessages.length > 200) chatMessages.shift();
  res.json(msg);
});

app.listen(PORT, () => console.log(`Demo running at http://localhost:${PORT}`));