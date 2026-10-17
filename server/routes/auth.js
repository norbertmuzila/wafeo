// ─── /api/auth ───────────────────────────────────────────────

const express = require('express');
const { OAuth2Client } = require('google-auth-library');
const config = require('../config');
const store = require('../store');
const { hashPassword, verifyPassword, publicUser, signToken, requireAuth, rateLimit } = require('../auth');

const router = express.Router();
const googleClient = new OAuth2Client();
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });

const session = user => ({ token: signToken(user), user: publicUser(user) });

router.post('/login', authLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const user = await store.findUserByLogin(String(username).trim());
  if (user && !user.password && user.authProvider === 'google') {
    return res.status(401).json({ error: 'This account uses Google sign-in. Use the "Sign in with Google" button.' });
  }
  const check = verifyPassword(String(password), user && user.password);
  if (!check.ok) return res.status(401).json({ error: 'Invalid username or password' });

  if (check.needsUpgrade) {
    store.updateUser(user.id, { password: hashPassword(String(password)) })
      .catch(err => console.warn('[auth] Password hash upgrade failed:', err.message));
  }
  res.json(session(user));
});

// Any Google account with a verified email can sign in. First-time
// users are registered automatically with the default role.
router.post('/google', authLimiter, async (req, res) => {
  const { credential } = req.body || {};
  if (!credential) return res.status(400).json({ error: 'Google credential (id_token) required' });

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: config.googleClientIds });
    payload = ticket.getPayload();
  } catch (err) {
    console.warn('[auth] Google token rejected:', err.message);
    return res.status(401).json({ error: 'Google sign-in could not be verified. Please try again.' });
  }
  if (!payload || !payload.email) return res.status(401).json({ error: 'Invalid Google token' });
  if (!payload.email_verified) return res.status(403).json({ error: 'Your Google email is not verified yet.' });

  try {
    let user = await store.findUserByEmail(payload.email);
    if (!user) {
      user = await store.createUser({
        username: await uniqueUsername(payload.email.split('@')[0]),
        email: payload.email,
        name: payload.name || payload.email.split('@')[0],
        role: config.adminEmails.includes(payload.email.toLowerCase()) ? 'admin' : config.defaultRole,
        password: '',
        googleId: payload.sub,
        picture: payload.picture || '',
        authProvider: 'google',
        region: 'Global'
      });
      console.log('[auth] New Google user:', user.email);
    } else if (!user.googleId || user.picture !== payload.picture) {
      // Link an existing email/password account to Google on first Google sign-in.
      const changes = { googleId: payload.sub, picture: payload.picture || user.picture || '' };
      await store.updateUser(user.id, changes);
      user = { ...user, ...changes };
    }
    res.json(session(user));
  } catch (err) {
    console.error('[auth] Google sign-in storage error:', err);
    res.status(500).json({ error: 'Could not complete sign-in. Please try again.' });
  }
});

router.post('/register', authLimiter, async (req, res) => {
  const { name, email, username, password, region } = req.body || {};
  if (!name || !email || !username || !password) {
    return res.status(400).json({ error: 'All fields are required (name, email, username, password)' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email address' });
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-32 letters, numbers, dots, dashes or underscores' });
  }
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  try {
    if (await store.findUserByLogin(username)) return res.status(409).json({ error: 'Username already taken' });
    if (await store.findUserByEmail(email)) return res.status(409).json({ error: 'Email already registered. Try signing in with Google or your password.' });

    const user = await store.createUser({
      username, email, name: String(name).trim(),
      password: hashPassword(String(password)),
      role: config.defaultRole,
      region: region || 'Global',
      authProvider: 'password'
    });
    res.status(201).json(session(user));
  } catch (err) {
    console.error('[auth] Registration failed:', err);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// Lets the frontend restore a saved session after a page reload.
router.get('/me', requireAuth, async (req, res) => {
  const user = await store.findUserById(req.user.id);
  if (!user) return res.status(401).json({ error: 'Account no longer exists' });
  res.json(session(user)); // fresh token extends the session
});

router.post('/logout', requireAuth, (req, res) => {
  res.json({ message: 'Logged out successfully' });
});

async function uniqueUsername(base) {
  const clean = base.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 24) || 'user';
  let candidate = clean;
  for (let i = 2; await store.findUserByLogin(candidate); i++) candidate = clean + i;
  return candidate;
}

module.exports = router;
