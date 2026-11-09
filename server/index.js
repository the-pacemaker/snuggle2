/* =============================================
   SNUGGLE — Sync Server
   
   Express server that serves static frontend files,
   handles Spotify proxy APIs, and runs the 
   WebSocket sync server for rooms.
   ============================================= */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const { setupWebSocket, teardownWebSocket } = require('./sync');
const { logEvent } = require('./analytics');
const statsRouter = require('./stats-router');
const { attachSignaling } = require('./coop/ws-adapter');
const { attachBattleCitySignaling } = require('./bcoop/ws-adapter');
const { attachContraSignaling } = require('./ccoop/ws-adapter');
const { mintToken, verifyToken } = require('./coop/mint-token');
const { getIceServers } = require('./ice-servers');
const COOP_SIGNAL_SECRET = process.env.COOP_SIGNAL_SECRET || 'snuggle-coop-secret-key-12345';

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1); // Trust first proxy for secure cookies

const SESSION_SECRET = process.env.SESSION_SECRET || 'snuggle-stats-fallback-secret-change-me';
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production' ? 'auto' : false, // auto sets secure if connection is HTTPS
    httpOnly: true,   // inaccessible via client-side JS
    sameSite: 'lax',  // 'strict' can cause issues with redirects from external providers, 'lax' is safer
    maxAge: 4 * 60 * 60 * 1000 // 4 hours
  }
}));

// ── Parse JSON body (analytics event endpoint) ────────────────────────────
app.use(express.json({ limit: '20kb' }));

// ── Analytics event endpoint (called by client tracker) ───────────────────
app.post('/api/analytics/event', async (req, res) => {
  try {
    const { eventType, data = {} } = req.body || {};
    if (!eventType || typeof eventType !== 'string') {
      return res.status(400).json({ error: 'Missing eventType' });
    }
    // Merge client-sent data with server-side info
    await logEvent(eventType, data, req);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Analytics endpoint] Error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── Stats admin router ─────────────────────────────────────────────────────
// Accessible at /stats — hidden from regular users, password protected
app.use('/stats', statsRouter);

// Block direct static file access to /stats directory unless authenticated
app.use('/stats', (req, res, next) => {
  if (req.session && req.session.statsAuthed) return next();
  res.redirect('/stats');
});

// Helper to check if a section request is a top-level room session request
function isTopLevelRoomRequest(req) {
  // If explicitly requested as embedded in iframe or browser sec-fetch-dest indicates iframe
  if (req.query.embedded === '1' || req.query.embedded === 'true') return false;
  if (req.headers['sec-fetch-dest'] === 'iframe') return false;
  // If room code is present in query string
  const code = (req.query.code || '').trim();
  return Boolean(code);
}

// Section routes: Top-level requests with room code serve room.html shell;
// inner iframe requests (or direct access without code) serve the section page.
const SECTION_ROUTES = [
  { paths: ['/home'], file: '../home.html' },
  { paths: ['/games', '/games/'], file: '../games/index.html' },
  { paths: ['/games/wordle', '/games/wordle/'], file: '../games/wordle/index.html' },
  { paths: ['/games/connections', '/games/connections/'], file: '../games/connections/index.html' },
  { paths: ['/games/strands', '/games/strands/'], file: '../games/strands/index.html' },
  { paths: ['/games/contra', '/games/contra/'], file: '../games/contra/index.html' },
  { paths: ['/games/battle-city', '/games/battle-city/'], file: '../games/battle-city/index.html' },
  { paths: ['/movies', '/movies/'], file: '../movies/index.html' },
  { paths: ['/youtube', '/youtube/'], file: '../youtube/index.html' },
  { paths: ['/call', '/call/'], file: '../call/index.html' }
];

SECTION_ROUTES.forEach(({ paths, file }) => {
  app.get(paths, (req, res) => {
    if (isTopLevelRoomRequest(req)) {
      return res.sendFile(path.join(__dirname, '../room.html'));
    }
    return res.sendFile(path.join(__dirname, file));
  });
});

// Route for /room and /room/
app.get(['/room', '/room/'], (req, res) => {
  res.sendFile(path.join(__dirname, '../room.html'));
});

// Route to retrieve WebRTC ICE servers (STUN and TURN relay)
app.get('/api/ice-servers', (req, res) => {
  res.json({ iceServers: getIceServers() });
});

// Route to mint/retrieve join token for Contra co-op signaling
app.get('/api/coop-token', (req, res) => {
  const room = (req.query.room || req.query.code || '').toUpperCase().trim();
  if (!room || !/^[A-Za-z0-9_-]{1,64}$/.test(room)) {
    return res.status(400).json({ error: 'Invalid or missing room code' });
  }
  const seat = req.query.seat || 'any';
  try {
    const token = mintToken({
      secret: COOP_SIGNAL_SECRET,
      room,
      seat: ['host', 'guest', 'any'].includes(seat) ? seat : 'any',
      ttlSeconds: 120
    });
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.json({ token, room, seat });
    }
    // Return token string directly so r.text() or JSON parse works
    return res.type('text/plain').send(token);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Serve the frontend static files from the root of snuggle
app.use(express.static(path.join(__dirname, '..')));

// Enable CORS for API routes just in case it's still accessed externally
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime()
  });
});

function collectVideoData(node, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectVideoData(item, out);
    return;
  }
  if (node.videoRenderer?.videoId) {
    const v = node.videoRenderer;
    out.push({
      id: v.videoId,
      title: v.title?.runs?.[0]?.text || '',
      thumbnail: v.thumbnail?.thumbnails?.[0]?.url || '',
      duration: v.lengthText?.simpleText || v.lengthText?.runs?.map(r => r.text).join('') || '',
      channel: v.ownerText?.runs?.[0]?.text || ''
    });
  }
  for (const key of Object.keys(node)) collectVideoData(node[key], out);
}

app.get('/api/yt-search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'Missing query' });
  const limit = parseInt(req.query.limit) || 20;

  try {
    const url = "https://www.youtube.com/results?search_query=" + encodeURIComponent(query) + "&sp=EgIQAQ%253D%253D";
    const ytRes = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        "Cookie": "CONSENT=YES+1; SOCS=CAI"
      }
    });
    
    if (!ytRes.ok) throw new Error(`YouTube returned ${ytRes.status}`);

    const html = await ytRes.text();
    const match = html.match(/var ytInitialData = (\{.*?\});<\/script>/s);
    if (!match) throw new Error("ytInitialData not found");

    const items = [];
    collectVideoData(JSON.parse(match[1]), items);
    
    const uniqueMap = new Map();
    for (const item of items) {
      if (!uniqueMap.has(item.id)) {
        uniqueMap.set(item.id, item);
      }
    }
    const uniqueItems = Array.from(uniqueMap.values()).slice(0, limit);

    // Log the search query for analytics
    logEvent('yt_search', { query, resultsCount: uniqueItems.length }, req).catch(() => {});
    
    res.json({ items: uniqueItems });
  } catch (err) {
    console.error('YT Search Error:', err.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Create HTTP server from Express app
const httpServer = http.createServer(app);

// Optional HTTPS server for secure mobile WebRTC on local Wi-Fi
let httpsServer = null;
const keyPath = path.join(__dirname, 'key.pem');
const certPath = path.join(__dirname, 'cert.pem');
if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
  try {
    httpsServer = https.createServer({
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath)
    }, app);
  } catch (err) {
    console.warn('Failed to start HTTPS server:', err.message);
  }
}

// Attach WebSocket server to HTTP and HTTPS
const { rooms } = setupWebSocket(httpServer, httpsServer);

// Attach Contra WebRTC signaling service
const coopSignaling = attachSignaling({
  servers: [httpServer, httpsServer].filter(Boolean),
  path: '/coop-signal',
  hubOptions: {
    iceServers: () => getIceServers()
  },
  authorize: async (room, req) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const token = url.searchParams.get('token');
      if (token) {
        const verified = verifyToken({ secret: COOP_SIGNAL_SECRET, room, token });
        if (verified) return { role: verified.seat };
      }
    } catch (_) {}
    return true;
  }
});

// Attach Battle City WebRTC signaling service
const bcoopSignaling = attachBattleCitySignaling({
  servers: [httpServer, httpsServer].filter(Boolean),
  paths: ['/bcoop-signal', '/bcoop-signal-solo', '/ws']
});

// Attach Contra WebRTC signaling service
const ccoopSignaling = attachContraSignaling({
  servers: [httpServer, httpsServer].filter(Boolean),
  paths: ['/ccoop-signal', '/contra-signal']
});

app.get('/api/wordle-daily', async (req, res) => {
  try {
    const d = new Date();
    const dateStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const nytUrl = `https://www.nytimes.com/svc/wordle/v2/${dateStr}.json`;
    const response = await fetch(nytUrl);
    if (!response.ok) throw new Error('NYT returned ' + response.status);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Wordle Daily Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch daily wordle' });
  }
});

app.get('/api/connections-daily', async (req, res) => {
  try {
    const d = new Date();
    const dateStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const nytUrl = `https://www.nytimes.com/svc/connections/v2/${dateStr}.json`;
    const response = await fetch(nytUrl);
    if (!response.ok) throw new Error('NYT returned ' + response.status);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Connections Daily Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch daily connections' });
  }
});

app.get('/api/strands-daily', async (req, res) => {
  try {
    const d = new Date();
    const dateStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const nytUrl = `https://www.nytimes.com/svc/strands/v2/${dateStr}.json`;
    const response = await fetch(nytUrl);
    if (!response.ok) throw new Error('NYT returned ' + response.status);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Strands Daily Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch daily strands' });
  }
});

// Update health check to include rooms
app.get('/health/rooms', (req, res) => {
  res.json({
    status: 'ok',
    rooms: rooms.size,
    uptime: process.uptime()
  });
});

// --- Graceful Shutdown ---
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

function shutdown() {
  console.log('Shutting down...');
  try { coopSignaling?.close?.(); } catch (e) {}
  try { bcoopSignaling?.close?.(); } catch (e) {}
  try { ccoopSignaling?.close?.(); } catch (e) {}
  teardownWebSocket();
  
  if (httpsServer) {
    try { httpsServer.close(); } catch (e) {}
  }
  httpServer.close(() => {
    console.log('Server stopped.');
    process.exit(0);
  });
}

// --- Start Server ---
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
httpServer.listen(PORT, () => {
  console.log(`🎬 Snuggle Sync Server running on port ${PORT}`);
  console.log(`   Local URL: http://localhost:${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/health`);
});

if (httpsServer) {
  httpsServer.listen(HTTPS_PORT, () => {
    console.log(`🔒 Snuggle HTTPS Server running on port ${HTTPS_PORT}`);
    console.log(`   Local HTTPS URL: https://localhost:${HTTPS_PORT}`);
  });
}
