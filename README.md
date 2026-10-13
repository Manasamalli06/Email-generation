# Email & Chat Integration Demo

Plug-and-play demo: a user fills in a short form, connects their Gmail with one click, and can then read their inbox, send email, and try a sample chat — all from one page.

## Run it

```bash
npm install
npm start
```

Open http://localhost:3000

Credentials live in `.env` (see `.env.example`). Never commit `.env`.

## One-time Google Cloud setup

In Google Cloud Console → APIs & Services:

1. **Enable the Gmail API** (Library → Gmail API → Enable).
2. **OAuth consent screen**: add the scopes `gmail.readonly` and `gmail.send` (plus email/profile). While the app is in "Testing" mode, add your Gmail address under **Test users**.
3. **Credentials → your OAuth client → Authorized redirect URIs**: add
   `http://localhost:3000/auth/google/callback`
   (for a deployed demo, add your real URL and set `REDIRECT_URI` in `.env` to match).

## How it works

| Step | What happens |
|------|--------------|
| 1. Your details | Form posts name / company / optional email to `/api/onboard` |
| 2. Connect email | `/auth/google` → Google consent → `/auth/google/callback` stores tokens in the server session |
| 3. Use it | `/api/emails` (inbox), `/api/emails/:id` (read), `/api/emails/send` (send), `/api/chat` (sample chat) |

## Files

- `server.js` – Express backend (OAuth, Gmail API, chat)
- `public/index.html` – front end (single page, no build step)
- `.env` – Google credentials and session secret

## Notes for production

- Sessions and chat are in memory; use Redis/DB for real deployments.
- Encrypt and persist refresh tokens per user if emails must be fetched in the background.
- Chat uses 2-second polling for simplicity; swap for WebSockets/SSE when scaling.
