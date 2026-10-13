// Shared helpers used by the email settings page and the inbox page.
const $ = (id) => document.getElementById(id);

async function api(url, body) {
  const opts = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined;
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Request failed');
  return data;
}

const getAccounts = () => api('/api/accounts');
const disconnectAccount = (id) => api('/api/accounts/' + id + '/disconnect', {});

// Start Google sign-in for one account; Google sends the user back to this same page.
function connectGoogle(role, hint) {
  const p = new URLSearchParams({ role, from: location.pathname });
  if (hint) p.set('hint', hint);
  location.href = '/auth/google?' + p.toString();
}

// Round badge: profile picture when we have one, otherwise initials.
function badge(acct) {
  const el = document.createElement('div');
  el.className = 'badge';
  const initials = (acct.name || acct.email || '?').split(/[\s@.]+/).filter(Boolean).slice(0, 2)
    .map((s) => s[0].toUpperCase()).join('');
  if (acct.picture) {
    const img = document.createElement('img');
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.src = acct.picture;
    img.onerror = () => { el.textContent = initials; };
    el.append(img);
  } else {
    el.textContent = initials;
  }
  return el;
}

// Reads ?connected=<id> or ?error=... after Google sends the user back, then cleans the URL.
function readFlash(accounts) {
  const q = new URLSearchParams(location.search);
  let out = null;
  if (q.get('connected')) {
    const a = accounts.find((x) => x.id === q.get('connected'));
    out = a
      ? { type: 'ok', text: a.email + ' is connected as ' + a.roleLabel + '.', id: a.id }
      : { type: 'ok', text: 'Your email account is connected.' };
  } else if (q.get('error')) {
    const e = q.get('error');
    const text = e === 'access_denied'
      ? 'Google did not allow this sign-in. If you cancelled, try again. If you saw "Access blocked", this Google account has not been approved for the app yet.'
      : 'Google sign-in did not finish (' + e + '). Please try again.';
    out = { type: 'err', text };
  }
  if (out) history.replaceState(null, '', location.pathname);
  return out;
}

function showFlash(el, flash) {
  if (!flash) { el.classList.add('hidden'); return; }
  el.className = 'alert ' + flash.type;
  el.textContent = flash.text;
  if (flash.id) {
    const a = document.createElement('a');
    a.href = '/inbox.html?account=' + flash.id;
    a.textContent = ' Open inbox';
    a.style.marginLeft = '8px';
    el.append(a);
  }
}