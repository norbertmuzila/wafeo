# WAFEO Digital Twin

Water, Agriculture & Food systems Earth Observation platform.
Live: **https://wafeo-webapplication.vercel.app**

Anyone with a Google account can sign in. First-time users get an account
automatically (role `researcher`). Admins can change roles in **Settings → Registered Users**.

---

## Project layout

```
index.html, style.css, app.js   Frontend (single-page app, no build step)
landing.css, landing.js         Home page: pinned scroll hero, sections, hand-off to sign-in
assets/                         Logo and static images (assets/landing/ = home page photo)
data/*.json                     Reference datasets + local user store
server.js                       Local entry point: `npm start`
api/index.js                    Vercel serverless entry (same app)
server/
  app.js                        Express app: middleware, routing, static files
  config.js                     All environment settings in one place
  store.js                      Data layer: Firestore if configured, else data/*.json
  auth.js                       Password hashing, JWT, auth/role middleware, rate limit
  routes/auth.js                /api/auth/*  login, google, register, me, logout
  routes/data.js                Dashboard datasets + live news
  routes/platform.js            AI assistant, reports, activity log, admin
  services/news.js              ReliefWeb + RSS news aggregator (15-min cache)
lib/firebase.js                 Firebase Admin initialisation
firebase-seed.js                One-off: copy data/*.json into Firestore (`npm run seed`)
tests/api.test.js               API tests (`npm test`)
```

## Run locally

```bash
npm install
cp .env.example .env      # optional locally; see below
npm run dev               # http://localhost:8080, restarts on file changes
npm test                  # API test suite (never touches data/)
```

Without a `.env` the server uses the JSON files in `data/` and a random session
secret (you'll be signed out when the server restarts).

Demo accounts (password `wafeo2024`): `admin`, `farmer`, `policy`, `researcher`.

## Environment variables

| Variable | Needed | Purpose |
|---|---|---|
| `JWT_SECRET` | **Production** | Signs session tokens. Any long random string. Without it (and without Firebase), the production API refuses to run. |
| `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` | Production | Firestore storage for users, reports and activity. Without them, new accounts are not saved on Vercel. |
| `GOOGLE_CLIENT_ID` | Optional | OAuth client ID(s), comma-separated. Defaults to the WAFEO client. |
| `ADMIN_EMAILS` | Optional | Comma-separated Google emails that become admin on first sign-in. |
| `DEFAULT_ROLE` | Optional | Role for new sign-ups (default `researcher`). |
| `GROQ_API_KEY`, `GROQ_MODEL` | Optional | Enables the AI assistant (free key at console.groq.com). |
| `CORS_ORIGINS` | Optional | Extra origins allowed to call the API. |
| `JWT_EXPIRES_IN` | Optional | Session length (default `7d`). |

Set these on Vercel under **Project → Settings → Environment Variables**, then redeploy.

## Google sign-in for everyone

The button works with the OAuth client in `GOOGLE_CLIENT_ID`. For *any* Google
account (not just test users) to sign in, in [Google Cloud Console](https://console.cloud.google.com/apis/credentials):

1. **APIs & Services → OAuth consent screen**: set *User type* to **External**
   and click **Publish app** so the status is **In production**. While it is
   "Testing", only listed test users can sign in. The app only asks for the
   basic `openid email profile` scopes, so Google does not require verification.
2. **Credentials → your Web client → Authorized JavaScript origins** must include:
   `https://wafeo-webapplication.vercel.app`, `http://localhost:8080`, and
   `https://norbertmuzila.github.io` if you still use GitHub Pages.

## API

All endpoints except health and auth require `Authorization: Bearer <token>`.

| Method | Endpoint | Notes |
|---|---|---|
| GET | `/api/health` | Status, storage backend, AI configured |
| POST | `/api/auth/login` | `{ username, password }` (username or email) |
| POST | `/api/auth/google` | `{ credential }` Google ID token |
| POST | `/api/auth/register` | `{ name, email, username, password, region }` |
| GET | `/api/auth/me` | Restore session, returns a fresh token |
| GET | `/api/dashboard/stats`, `/api/alerts`, `/api/satellites`, `/api/analytics/ndvi-by-region`, `/api/fields`, `/api/water`, `/api/food-security`, `/api/countries` | Datasets |
| GET | `/api/news?limit=n` | Live news |
| POST | `/api/ai/chat` | `{ messages: [{ role, content }] }` |
| GET/POST | `/api/reports` | Saved reports (per user) |
| GET | `/api/admin/users`, `/api/admin/activity` | Admin only |
| POST | `/api/admin/users/:id/role` | Admin only, `{ role }` |

## Security notes

- Passwords are salted scrypt hashes. Older SHA-256 hashes are upgraded on the next login.
- Login, sign-up and AI endpoints are rate-limited.
- Only `index.html`, `app.js`, `style.css`, `assets/` and the public datasets are served; server code, `.env` and `users.json` are not.
