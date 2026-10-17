// ─── Authentication helpers ──────────────────────────────────

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('./config');

// Passwords are stored as "scrypt$<salt>$<hash>". Older accounts hold an
// unsalted SHA-256 hex digest; those still verify and are upgraded on
// the next successful login (see routes/auth.js).
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !password) return { ok: false };
  if (stored.startsWith('scrypt$')) {
    const [, salt, hash] = stored.split('$');
    const actual = crypto.scryptSync(password, salt, 64);
    const expected = Buffer.from(hash, 'hex');
    return { ok: expected.length === actual.length && crypto.timingSafeEqual(actual, expected) };
  }
  const legacy = crypto.createHash('sha256').update(password).digest('hex');
  const ok = legacy.length === stored.length && crypto.timingSafeEqual(Buffer.from(legacy), Buffer.from(stored));
  return { ok, needsUpgrade: ok };
}

function publicUser(user) {
  if (!user) return null;
  const { password, ...safe } = user;
  return safe;
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, name: user.name, email: user.email },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = jwt.verify(token, config.jwtSecret);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => roles.includes(req.user && req.user.role)
    ? next()
    : res.status(403).json({ error: 'Insufficient permissions' });
}

// Small in-memory limiter: enough to blunt password guessing and AI
// abuse on a single instance without adding a dependency.
function rateLimit({ windowMs, max, key = req => req.ip }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const k = key(req);
    const entry = hits.get(k);
    if (!entry || now - entry.start > windowMs) {
      hits.set(k, { start: now, count: 1 });
    } else if (++entry.count > max) {
      res.set('Retry-After', Math.ceil((entry.start + windowMs - now) / 1000));
      return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
    }
    if (hits.size > 10000) hits.clear();
    next();
  };
}

module.exports = { hashPassword, verifyPassword, publicUser, signToken, requireAuth, requireRole, rateLimit };
