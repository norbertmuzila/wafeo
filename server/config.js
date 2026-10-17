// ─── Runtime configuration ───────────────────────────────────
// Every setting comes from the environment (.env locally, project
// settings on Vercel). Nothing secret is hard-coded here.

require('dotenv').config();
const crypto = require('crypto');

const isProduction = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;

// The JWT secret signs every session token. A secret that ships in the
// public repo lets anyone forge an admin session, so there is no default.
// Order of preference:
//   1. JWT_SECRET
//   2. a key derived from FIREBASE_PRIVATE_KEY (already secret on Vercel)
//   3. local development only: a random per-process secret
function resolveJwtSecret() {
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 16) {
    return { secret: process.env.JWT_SECRET, source: 'JWT_SECRET' };
  }
  if (process.env.FIREBASE_PRIVATE_KEY) {
    const derived = crypto.createHash('sha256')
      .update('wafeo-jwt:' + process.env.FIREBASE_PRIVATE_KEY)
      .digest('hex');
    return { secret: derived, source: 'derived from FIREBASE_PRIVATE_KEY' };
  }
  if (!isProduction) {
    return { secret: crypto.randomBytes(32).toString('hex'), source: 'random (dev only; sessions reset on restart)' };
  }
  return { secret: null, source: 'missing' };
}

const jwt = resolveJwtSecret();

// Comma-separated list so a second OAuth client (e.g. a staging one) can be added.
const googleClientIds = (process.env.GOOGLE_CLIENT_ID || '681642080635-fpqmjobr8hnt63adria7qmlk3kar8kej.apps.googleusercontent.com')
  .split(',').map(s => s.trim()).filter(Boolean);

const corsOrigins = [
  'https://norbertmuzila.github.io',
  'https://wafeo.vercel.app',
  'https://wafeo-webapplication.vercel.app',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
  'http://localhost:8080',
  ...(process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
];

module.exports = {
  isProduction,
  port: Number(process.env.PORT) || 8080,
  jwtSecret: jwt.secret,
  jwtSecretSource: jwt.source,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  googleClientIds,
  // Role given to people who sign up themselves (Google or email).
  defaultRole: process.env.DEFAULT_ROLE || 'researcher',
  // Emails (comma-separated) that become admins when they first sign in with Google.
  adminEmails: (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  corsOrigins,
  groqApiKey: process.env.GROQ_API_KEY || '',
  groqModel: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
  dataDir: require('path').join(__dirname, '..', 'data'),
  // Lets tests point the JSON store at a temp copy without touching data/.
  usersFile: process.env.WAFEO_USERS_FILE || null
};
