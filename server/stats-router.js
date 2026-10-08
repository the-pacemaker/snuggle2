/* =============================================
   SNUGGLE — Stats / Admin Router
   
   Routes:
     GET  /stats           → login page or dashboard
     POST /stats/login     → authenticate
     POST /stats/logout    → clear session
     GET  /api/stats/data  → JSON stats (auth required)
     GET  /api/stats/search→ search events (auth required)
   ============================================= */

const express = require('express');
const bcrypt = require('bcrypt');
const path = require('path');
const { getStats, searchEvents } = require('./analytics');

const router = express.Router();

// ── Password (hashed at startup) ──────────────────────────────────────────
// The plaintext password is only ever used once to create the hash.
// It is never stored anywhere after this point.
const STATS_PASSWORD_HASH = bcrypt.hashSync('8146916697<3', 12);

// ── Rate limiting for login attempts ─────────────────────────────────────
const loginAttempts = new Map(); // ip → { count, firstAttempt }
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

function isRateLimited(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (!record) return false;
  if (now - record.firstAttempt > WINDOW_MS) {
    loginAttempts.delete(ip);
    return false;
  }
  return record.count >= MAX_ATTEMPTS;
}

function recordAttempt(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (!record || now - record.firstAttempt > WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, firstAttempt: now });
  } else {
    record.count++;
  }
}

function clearAttempts(ip) {
  loginAttempts.delete(ip);
}

// ── Auth middleware ───────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.statsAuthed) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return res.redirect('/stats');
}

// ── GET /stats ────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  if (req.session && req.session.statsAuthed) {
    return res.sendFile(path.join(__dirname, '../stats/index.html'));
  }
  return res.sendFile(path.join(__dirname, '../stats/login.html'));
});

// ── POST /stats/login ─────────────────────────────────────────────────────
router.post('/login', express.urlencoded({ extended: false }), express.json(), async (req, res) => {
  const ip = (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    'unknown'
  );

  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  }

  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ error: 'Password required' });
  }

  const match = await bcrypt.compare(password, STATS_PASSWORD_HASH);
  if (!match) {
    recordAttempt(ip);
    return res.status(401).json({ error: 'Wrong password' });
  }

  clearAttempts(ip);
  req.session.statsAuthed = true;
  req.session.authedAt = Date.now();
  return res.json({ ok: true });
});

// ── POST /stats/logout ────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

// ── GET /api/stats/data ───────────────────────────────────────────────────
router.get('/api/data', requireAuth, async (req, res) => {
  try {
    const stats = await getStats();
    if (!stats) return res.status(503).json({ error: 'Analytics database not available' });
    res.json(stats);
  } catch (err) {
    console.error('[Stats API] Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/stats/search ─────────────────────────────────────────────────
router.get('/api/search', requireAuth, async (req, res) => {
  try {
    const { q, eventType, dateFrom, dateTo, limit } = req.query;
    const results = await searchEvents({
      query: q,
      eventType,
      dateFrom,
      dateTo,
      limit: Math.min(parseInt(limit) || 100, 500)
    });
    res.json({ results });
  } catch (err) {
    console.error('[Stats Search] Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Session check ─────────────────────────────────────────────────────────
router.get('/api/check', (req, res) => {
  res.json({ authed: !!(req.session && req.session.statsAuthed) });
});

module.exports = router;
