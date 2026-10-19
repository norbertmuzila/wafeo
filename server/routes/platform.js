// ─── AI assistant, reports, activity log, admin ──────────────

const express = require('express');
const config = require('../config');
const store = require('../store');
const { requireAuth, requireRole, rateLimit, publicUser } = require('../auth');

const router = express.Router();
router.use(requireAuth);

// ─── AI Assistant (Groq proxy; the key never reaches the browser) ─
const SYSTEM_PROMPT = 'You are the WAFEO Digital Twin AI Assistant. You help users interpret Earth Observation data: NDVI vegetation health, water resources, drought, soil and food-security signals across Africa and globally. Be concise, professional and clear. Prefer short paragraphs and bullet points. If asked something outside Earth observation/agriculture/water/food security, answer briefly and steer back to the platform.';

const aiLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, key: req => 'u' + req.user.id });

router.post('/ai/chat', aiLimiter, async (req, res) => {
  const raw = Array.isArray(req.body && req.body.messages) ? req.body.messages : null;
  if (!raw) return res.status(400).json({ error: 'messages array required' });

  // Only user/assistant turns from the client; the system prompt is ours.
  const messages = raw
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-20)
    .map(m => ({ role: m.role, content: m.content.slice(0, 8000) }));
  if (!messages.length) return res.status(400).json({ error: 'No user message' });

  if (!config.groqApiKey) {
    return res.status(503).json({
      error: 'AI not configured',
      reply: 'The WAFEO AI assistant is not configured yet. An administrator needs to add a GROQ_API_KEY environment variable in the deployment settings (free tier available at console.groq.com).'
    });
  }

  try {
    for (const model of config.groqModels) {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.groqApiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
          temperature: 0.5,
          max_tokens: 1024,
          // gpt-oss models reason before answering; keep that short.
          ...(model.startsWith('openai/gpt-oss') ? { reasoning_effort: 'low' } : {})
        }),
        signal: AbortSignal.timeout(30000)
      });
      if (r.ok) {
        const data = await r.json();
        return res.json({ reply: data?.choices?.[0]?.message?.content || 'No response generated.' });
      }
      const errText = (await r.text()).slice(0, 300);
      console.error('[ai] Groq error:', model, r.status, errText);
      // Retired or unknown model: try the next one. Anything else is final.
      if (!(r.status === 404 || (r.status === 400 && /model/i.test(errText)))) break;
    }
    res.status(502).json({ error: 'AI provider error', reply: 'Sorry, the AI service returned an error. Please try again shortly.' });
  } catch (err) {
    console.error('[ai] Request failed:', err.message);
    res.status(502).json({ error: 'AI request failed', reply: 'Sorry, I could not reach the AI service right now.' });
  }
});

// ─── Reports ─────────────────────────────────────────────────
router.post('/reports', async (req, res) => {
  const body = req.body || {};
  const report = {
    userId: req.user.id,
    username: req.user.username,
    title: String(body.title || 'WAFEO Comprehensive Report').slice(0, 200),
    region: String(body.region || 'Global').slice(0, 100),
    summary: String(body.summary || '').slice(0, 20000),
    sections: Array.isArray(body.sections) ? body.sections.slice(0, 50) : [],
    metrics: body.metrics && typeof body.metrics === 'object' ? body.metrics : {},
    createdAt: new Date().toISOString()
  };
  try {
    const { id, persistent } = await store.addReport(report);
    res.json({ saved: true, persistent, id, report });
  } catch (err) {
    console.error('[reports] Save failed:', err.message);
    res.status(500).json({ saved: false, error: 'Failed to save report' });
  }
});

router.get('/reports', async (req, res) => {
  try {
    const reports = await store.listReports(req.user.id);
    res.json({ reports, total: reports.length });
  } catch (err) {
    console.error('[reports] List failed:', err.message);
    res.status(500).json({ error: 'Failed to list reports' });
  }
});

// ─── Activity log ────────────────────────────────────────────
router.post('/activity/log', async (req, res) => {
  const { action, details } = req.body || {};
  try {
    await store.logActivity({
      userId: req.user.id,
      username: req.user.username,
      action: String(action || 'unknown').slice(0, 64),
      details: String(details || '').slice(0, 500),
      timestamp: new Date().toISOString()
    });
    res.json({ logged: true });
  } catch (err) {
    console.error('[activity] Log failed:', err.message);
    res.json({ logged: false });
  }
});

// ─── Admin ───────────────────────────────────────────────────
router.get('/admin/users', requireRole('admin'), async (req, res) => {
  try {
    const users = (await store.listUsers()).map(publicUser);
    res.json({ users, total: users.length });
  } catch (err) {
    res.status(500).json({ error: 'User store unavailable' });
  }
});

const ROLES = ['admin', 'farmer', 'policy', 'researcher'];
router.post('/admin/users/:id/role', requireRole('admin'), async (req, res) => {
  const { role } = req.body || {};
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Role must be one of: ' + ROLES.join(', ') });
  if (String(req.params.id) === String(req.user.id)) return res.status(400).json({ error: 'You cannot change your own role' });
  const user = await store.findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  await store.updateUser(user.id, { role });
  res.json({ user: publicUser({ ...user, role }) });
});

router.get('/admin/activity', requireRole('admin'), async (req, res) => {
  try {
    const logs = await store.listActivity(100);
    res.json({ logs, total: logs.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve activity logs' });
  }
});

module.exports = router;
