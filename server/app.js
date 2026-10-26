// ─── Express application ─────────────────────────────────────
// Built here and exported so the same app runs locally (server.js)
// and as a Vercel serverless function (api/index.js).

const express = require('express');
const cors = require('cors');
const path = require('path');
const compression = require('compression');
const config = require('./config');
const store = require('./store');

const app = express();

// A stray rejection inside a data library must not take the whole server down.
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));
const ROOT = path.join(__dirname, '..');

app.disable('x-powered-by');
app.set('trust proxy', 1); // correct client IPs behind Vercel for rate limiting
app.use(cors({
  origin: config.corsOrigins,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// ─── API ─────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: config.jwtSecret ? 'ok' : 'misconfigured',
    service: 'WAFEO Digital Twin API',
    version: '2.1.0',
    store: store.backend(),
    aiConfigured: !!config.groqApiKey,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Without a signing secret no session can be trusted, so refuse
// everything except the health check rather than run insecurely.
app.use('/api', (req, res, next) => config.jwtSecret ? next() : res.status(503).json({
  error: 'Server is missing JWT_SECRET. The site administrator must set it in the deployment environment.'
}));

app.use('/api/geo', require('./routes/geo'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api', require('./routes/data'));
app.use('/api', require('./routes/platform'));
app.use('/api', require('./routes/eo'));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use('/api', (err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });
  console.error('[api] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Frontend ────────────────────────────────────────────────
// Only the public files are served. The rest of the project
// (server code, .env, users.json) must never be downloadable.
const sendFile = file => (req, res) => res.sendFile(path.join(ROOT, file));
const PUBLIC_FILES = ['/app.js', '/style.css', '/landing.js', '/landing.css', '/privacy.html', '/eo.js', '/pages.js', '/atlas.js', '/report.js', '/livenews.js', '/compare.js', '/assistant.js', '/icons.js'];
app.get(PUBLIC_FILES, (req, res) => res.sendFile(path.join(ROOT, req.path)));
app.get('/privacy', sendFile('privacy.html'));
app.use('/assets', express.static(path.join(ROOT, 'assets')));
app.get('*', sendFile('index.html'));

module.exports = app;
