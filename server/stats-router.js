/* =============================================
   SNUGGLE — Stats / Admin Router
   
   Routes:
     GET  /stats                → login page or dashboard
     POST /stats/login          → authenticate (password: 8146916697<3)
     POST /stats/logout         → clear session
     GET  /stats/api/check      → session check
     GET  /stats/api/data       → general analytics & user summaries (auth required)
     GET  /stats/api/user/:ip   → detailed individual user activity timeline (auth required)
     GET  /stats/api/ip-names   → get all IP assigned names (auth required)
     POST /stats/api/ip-names   → assign/update name for an IP (auth required)
     DELETE /stats/api/ip-names/:ip → delete assigned name for an IP (auth required)
     GET  /stats/api/search     → search events with filters (auth required)
     POST /stats/api/wipe       → wipe analytics data (auth required)
   ============================================= */

const express = require('express');
const bcrypt = require('bcrypt');
const path = require('path');
const {
  getStats,
  getUserActivity,
  searchEvents,
  getIpNames,
  setIpName,
  deleteIpName,
  wipeAllData
} = require('./analytics');

const router = express.Router();

// ── Password (hashed at startup) ──────────────────────────────────────────
// Preserved exact original password: 8146916697<3
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
    req.headers['cf-connecting-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    'unknown'
  );

  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  }

  const { password } = req.body || {};
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

  req.session.save((err) => {
    if (err) {
      console.error('[Stats API] Session save error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
    return res.json({ ok: true });
  });
});

// ── POST /stats/logout ────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

// ── Session check ─────────────────────────────────────────────────────────
router.get('/api/check', (req, res) => {
  res.json({ authed: !!(req.session && req.session.statsAuthed) });
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

// ── GET /api/stats/user/:ip ───────────────────────────────────────────────
router.get('/api/user/:ip', requireAuth, async (req, res) => {
  try {
    const { ip } = req.params;
    const userActivity = await getUserActivity(ip);
    if (!userActivity) return res.status(404).json({ error: 'User not found' });
    res.json(userActivity);
  } catch (err) {
    console.error('[Stats API User] Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── IP Names Management ───────────────────────────────────────────────────
router.get('/api/ip-names', requireAuth, (req, res) => {
  try {
    res.json({ ipNames: getIpNames() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/ip-names', requireAuth, express.json(), (req, res) => {
  try {
    const { ip, name, notes } = req.body || {};
    if (!ip) return res.status(400).json({ error: 'IP address required' });
    const updated = setIpName(ip, name, notes);
    res.json({ ok: true, ipNames: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/api/ip-names/:ip', requireAuth, (req, res) => {
  try {
    const { ip } = req.params;
    const updated = deleteIpName(ip);
    res.json({ ok: true, ipNames: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/stats/search ─────────────────────────────────────────────────
router.get('/api/search', requireAuth, async (req, res) => {
  try {
    const { q, eventType, dateFrom, dateTo, ip, limit } = req.query;
    const results = await searchEvents({
      query: q,
      eventType,
      dateFrom,
      dateTo,
      ip,
      limit: Math.min(parseInt(limit) || 100, 500)
    });
    res.json({ results });
  } catch (err) {
    console.error('[Stats Search] Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/stats/wipe ──────────────────────────────────────────────────
router.post('/api/wipe', requireAuth, async (req, res) => {
  try {
    const result = await wipeAllData();
    res.json(result);
  } catch (err) {
    console.error('[Stats Wipe] Error:', err.message);
    res.status(500).json({ error: 'Wipe failed' });
  }
});

module.exports = router;
