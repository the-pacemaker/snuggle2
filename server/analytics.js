/* =============================================
   SNUGGLE — Analytics Module
   
   Handles all event tracking, data collection,
   IP name resolution, user timeline analysis,
   and stats dashboard reporting.
   
   Storage:
     • Primary: Supabase (PostgreSQL)
     • Local fallback: server/data/analytics-events.jsonl
     • IP Name Directory: server/data/ip-names.json
   ============================================= */

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const IP_NAMES_FILE = path.join(DATA_DIR, 'ip-names.json');
const LOCAL_EVENTS_FILE = path.join(DATA_DIR, 'analytics-events.jsonl');

if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
}

let supabase = null;

function getClient() {
  if (supabase) return supabase;
  const url = process.env.SUPABASE_URL || 'https://gmdljmtmbaudmkgmahvs.supabase.co';
  const key = process.env.SUPABASE_SERVICE_KEY || 'sb_publishable_enaBOcAmbXRYQokSoLl94w_Vxapdfhs';
  if (!url || !key) {
    console.warn('[Analytics] Supabase credentials missing');
    return null;
  }
  supabase = createClient(url, key);
  return supabase;
}

// ── IP Name Directory ────────────────────────────────────────────────────────
function loadIpNames() {
  try {
    if (fs.existsSync(IP_NAMES_FILE)) {
      const raw = fs.readFileSync(IP_NAMES_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error('[Analytics] Failed to load ip-names.json:', err.message);
  }
  return {};
}

function saveIpNames(names) {
  try {
    fs.writeFileSync(IP_NAMES_FILE, JSON.stringify(names, null, 2), 'utf8');
  } catch (err) {
    console.error('[Analytics] Failed to save ip-names.json:', err.message);
  }
}

let ipNamesCache = loadIpNames();

function getIpNames() {
  return ipNamesCache;
}

function getIpName(ip) {
  if (!ip) return null;
  const clean = cleanIp(ip);
  return ipNamesCache[clean]?.name || null;
}

function setIpName(ip, name, notes = '') {
  if (!ip) return ipNamesCache;
  const clean = cleanIp(ip);
  const cleanName = String(name || '').trim();

  if (!cleanName) {
    delete ipNamesCache[clean];
  } else {
    ipNamesCache[clean] = {
      name: cleanName,
      notes: notes ? String(notes).trim() : (ipNamesCache[clean]?.notes || ''),
      updatedAt: new Date().toISOString()
    };
  }
  saveIpNames(ipNamesCache);
  return ipNamesCache;
}

function deleteIpName(ip) {
  if (!ip) return ipNamesCache;
  const clean = cleanIp(ip);
  delete ipNamesCache[clean];
  saveIpNames(ipNamesCache);
  return ipNamesCache;
}

// ── Client Information Extraction ──────────────────────────────────────────
function cleanIp(ip) {
  if (!ip) return 'unknown';
  let s = String(ip).trim();
  if (s === '::1' || s === '::ffff:127.0.0.1') return '127.0.0.1';
  if (s.startsWith('::ffff:')) return s.slice(7);
  return s;
}

function extractClientInfo(req) {
  const ua = req.headers['user-agent'] || '';
  const rawIp = (
    req.headers['cf-connecting-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    'unknown'
  );

  const ip = cleanIp(rawIp);

  return {
    ip_address: ip,
    user_agent: ua,
    referrer: req.headers['referer'] || req.headers['referrer'] || null,
    country: req.headers['cf-ipcountry'] || null,
    device_type: detectDevice(ua),
    browser: detectBrowser(ua),
    os: detectOS(ua),
    language: req.headers['accept-language']?.split(',')[0] || null,
    screen_width: null,
    screen_height: null,
  };
}

function detectDevice(ua) {
  if (/tablet|ipad/i.test(ua)) return 'tablet';
  if (/mobile|android|iphone|ipod|blackberry|windows phone/i.test(ua)) return 'mobile';
  return 'desktop';
}

function detectBrowser(ua) {
  if (/edg\//i.test(ua)) return 'Edge';
  if (/opr\/|opera/i.test(ua)) return 'Opera';
  if (/chrome|crios/i.test(ua)) return 'Chrome';
  if (/firefox|fxios/i.test(ua)) return 'Firefox';
  if (/safari/i.test(ua) && !/chrome|crios/i.test(ua)) return 'Safari';
  if (/msie|trident/i.test(ua)) return 'IE';
  return 'Other';
}

function detectOS(ua) {
  if (/windows/i.test(ua)) return 'Windows';
  if (/mac os|macintosh/i.test(ua)) return 'macOS';
  if (/android/i.test(ua)) return 'Android';
  if (/iphone|ipad|ipod/i.test(ua)) return 'iOS';
  if (/linux/i.test(ua)) return 'Linux';
  return 'Other';
}

// ── Append to Local JSONL Fallback ──────────────────────────────────────────
function appendLocalEvent(record) {
  try {
    fs.appendFileSync(LOCAL_EVENTS_FILE, JSON.stringify(record) + '\n', 'utf8');
  } catch (err) {
    console.error('[Analytics] Failed to append local event:', err.message);
  }
}

function readLocalEvents(limit = 1000) {
  try {
    if (!fs.existsSync(LOCAL_EVENTS_FILE)) return [];
    const lines = fs.readFileSync(LOCAL_EVENTS_FILE, 'utf8').split('\n').filter(Boolean);
    const events = [];
    for (let i = lines.length - 1; i >= 0 && events.length < limit; i--) {
      try { events.push(JSON.parse(lines[i])); } catch (_) {}
    }
    return events;
  } catch (err) {
    console.error('[Analytics] Failed to read local events:', err.message);
    return [];
  }
}

// ── Log Event ──────────────────────────────────────────────────────────────
async function logEvent(eventType, data = {}, req = null) {
  const clientInfo = req ? extractClientInfo(req) : {};

  if (data.screen_width) clientInfo.screen_width = Number(data.screen_width) || null;
  if (data.screen_height) clientInfo.screen_height = Number(data.screen_height) || null;

  const record = {
    event_type: eventType,
    data: data || {},
    ...clientInfo,
    created_at: new Date().toISOString()
  };

  // Always log locally
  appendLocalEvent(record);

  // Log to Supabase
  const db = getClient();
  if (db) {
    try {
      const { error } = await db.from('analytics_events').insert(record);
      if (error) console.error('[Analytics] Supabase insert error:', error.message);
    } catch (err) {
      console.error('[Analytics] Supabase error:', err.message);
    }
  }

  return record;
}

// ── User Aggregation Helper ─────────────────────────────────────────────────
function buildUserSummary(events, ipNames) {
  const userMap = new Map();

  events.forEach(e => {
    const ip = e.ip_address || 'unknown';
    const vid = e.data?.visitor_id || null;
    const userKey = ip; // Group primarily by IP for directory naming consistency

    if (!userMap.has(userKey)) {
      userMap.set(userKey, {
        ip: ip,
        visitorIds: new Set(),
        name: ipNames[ip]?.name || null,
        notes: ipNames[ip]?.notes || null,
        eventCount: 0,
        firstSeen: e.created_at,
        lastActive: e.created_at,
        devices: {},
        browsers: {},
        oses: {},
        countries: new Set(),
        eventCounts: {
          page_view: 0,
          page_leave: 0,
          yt_watch: 0,
          yt_search: 0,
          movie_watch: 0,
          game_play: 0,
          call_start: 0,
          call_end: 0,
          call_event: 0,
          room_create: 0,
          room_join: 0,
          activity_select: 0,
        },
        recentActivities: [],
      });
    }

    const u = userMap.get(userKey);
    u.eventCount++;
    if (vid) u.visitorIds.add(vid);

    if (e.country) u.countries.add(e.country);
    if (e.device_type) u.devices[e.device_type] = (u.devices[e.device_type] || 0) + 1;
    if (e.browser) u.browsers[e.browser] = (u.browsers[e.browser] || 0) + 1;
    if (e.os) u.oses[e.os] = (u.oses[e.os] || 0) + 1;

    const t = e.event_type;
    u.eventCounts[t] = (u.eventCounts[t] || 0) + 1;

    // Track timestamps
    if (new Date(e.created_at) < new Date(u.firstSeen)) u.firstSeen = e.created_at;
    if (new Date(e.created_at) > new Date(u.lastActive)) u.lastActive = e.created_at;

    // Keep up to 5 most recent activities in the user card
    if (u.recentActivities.length < 5) {
      u.recentActivities.push({
        event_type: e.event_type,
        created_at: e.created_at,
        data: e.data || {},
        device_type: e.device_type
      });
    }
  });

  // Pick top device, browser, OS, country
  return Array.from(userMap.values()).map(u => {
    let topDevice = 'desktop', maxDev = 0;
    for (const [d, c] of Object.entries(u.devices)) {
      if (c > maxDev) { maxDev = c; topDevice = d; }
    }

    let topBrowser = 'Other', maxB = 0;
    for (const [b, c] of Object.entries(u.browsers)) {
      if (c > maxB) { maxB = c; topBrowser = b; }
    }

    let topOs = 'Other', maxO = 0;
    for (const [o, c] of Object.entries(u.oses)) {
      if (c > maxO) { maxO = c; topOs = o; }
    }

    return {
      ip: u.ip,
      visitorId: Array.from(u.visitorIds)[0] || null,
      visitorCount: u.visitorIds.size,
      name: u.name,
      notes: u.notes,
      eventCount: u.eventCount,
      firstSeen: u.firstSeen,
      lastActive: u.lastActive,
      deviceType: topDevice,
      browser: topBrowser,
      os: topOs,
      country: Array.from(u.countries)[0] || null,
      eventCounts: u.eventCounts,
      recentActivities: u.recentActivities
    };
  }).sort((a, b) => new Date(b.lastActive) - new Date(a.lastActive));
}

// ── Query Dashboard Stats ──────────────────────────────────────────────────
async function getStats() {
  const db = getClient();
  const ipNames = getIpNames();

  let allEvents = [];

  if (db) {
    try {
      const { data, error } = await db
        .from('analytics_events')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(1000);

      if (!error && Array.isArray(data)) {
        allEvents = data;
      }
    } catch (err) {
      console.warn('[Analytics] Supabase query failed, falling back to local file:', err.message);
    }
  }

  // Fallback to local events if Supabase is empty or failed
  if (allEvents.length === 0) {
    allEvents = readLocalEvents(1000);
  }

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOf7Days = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const startOf30Days = Date.now() - 30 * 24 * 60 * 60 * 1000;

  const todayEvents = [];
  const week7Events = [];
  const month30Events = [];

  allEvents.forEach(e => {
    const t = new Date(e.created_at).getTime();
    if (t >= startOfToday) todayEvents.push(e);
    if (t >= startOf7Days) week7Events.push(e);
    if (t >= startOf30Days) month30Events.push(e);
  });

  const users = buildUserSummary(allEvents, ipNames);

  // Calculate aggregates
  const uniqueIPs = new Set(allEvents.map(e => e.ip_address).filter(Boolean)).size;
  const uniqueVisitors = new Set(allEvents.map(e => e.data?.visitor_id || e.ip_address).filter(Boolean)).size;
  const totalViews = allEvents.filter(e => e.event_type === 'page_view').length;
  const totalYt = allEvents.filter(e => e.event_type === 'yt_watch').length;
  const totalGames = allEvents.filter(e => e.event_type === 'game_play').length;
  const totalMovies = allEvents.filter(e => e.event_type === 'movie_watch').length;
  const totalCalls = allEvents.filter(e => e.event_type === 'call_start' || e.event_type === 'call_event').length;
  const totalRooms = allEvents.filter(e => e.event_type === 'room_create' || e.event_type === 'room_join').length;

  return {
    recentEvents: allEvents,
    todayEvents,
    week7Events,
    month30Events,
    users,
    ipNames,
    aggregates: {
      totalEvents: allEvents.length,
      uniqueIPs,
      uniqueVisitors,
      totalViews,
      totalYt,
      totalGames,
      totalMovies,
      totalCalls,
      totalRooms
    }
  };
}

// ── Individual User Activity Timeline ──────────────────────────────────────
async function getUserActivity(ipOrVid) {
  if (!ipOrVid) return null;
  const target = String(ipOrVid).trim();
  const ipNames = getIpNames();

  let userEvents = [];
  const db = getClient();

  if (db) {
    try {
      // Query events by IP
      const { data, error } = await db
        .from('analytics_events')
        .select('*')
        .eq('ip_address', target)
        .order('created_at', { ascending: false })
        .limit(500);

      if (!error && Array.isArray(data) && data.length > 0) {
        userEvents = data;
      }
    } catch (err) {
      console.warn('[Analytics] Supabase user query error:', err.message);
    }
  }

  // Fallback to local events if needed or search by visitor_id
  if (userEvents.length === 0) {
    const local = readLocalEvents(2000);
    userEvents = local.filter(e => 
      e.ip_address === target || 
      e.data?.visitor_id === target
    );
  }

  if (userEvents.length === 0) {
    return {
      user: {
        ip: target,
        name: ipNames[target]?.name || null,
        notes: ipNames[target]?.notes || null,
        eventCount: 0,
        firstSeen: null,
        lastActive: null
      },
      events: []
    };
  }

  // Aggregate this individual user's statistics
  const userSummaries = buildUserSummary(userEvents, ipNames);
  const userProfile = userSummaries[0] || {
    ip: target,
    name: ipNames[target]?.name || null,
    notes: ipNames[target]?.notes || null,
    eventCount: userEvents.length,
    firstSeen: userEvents[userEvents.length - 1]?.created_at,
    lastActive: userEvents[0]?.created_at
  };

  return {
    user: userProfile,
    events: userEvents
  };
}

// ── Search Analytics Events ────────────────────────────────────────────────
async function searchEvents({ query, eventType, dateFrom, dateTo, ip, limit = 100 }) {
  const db = getClient();
  let pool = [];

  if (db) {
    try {
      let q = db
        .from('analytics_events')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(Math.min(limit * 2, 1000));

      if (eventType && eventType !== 'all') q = q.eq('event_type', eventType);
      if (ip) q = q.eq('ip_address', ip);
      if (dateFrom) q = q.gte('created_at', dateFrom);
      if (dateTo) q = q.lte('created_at', dateTo);

      const { data, error } = await q;
      if (!error && Array.isArray(data)) pool = data;
    } catch (err) {
      console.error('[Analytics] Search DB error:', err.message);
    }
  }

  if (pool.length === 0) {
    pool = readLocalEvents(1000);
  }

  const ql = query ? query.toLowerCase().trim() : '';

  let results = pool.filter(e => {
    if (eventType && eventType !== 'all' && e.event_type !== eventType) return false;
    if (ip && e.ip_address !== ip) return false;
    if (dateFrom && e.created_at < dateFrom) return false;
    if (dateTo && e.created_at > dateTo) return false;

    if (ql) {
      const assignedName = (ipNamesCache[e.ip_address]?.name || '').toLowerCase();
      const ipMatch = (e.ip_address || '').toLowerCase().includes(ql);
      const nameMatch = assignedName.includes(ql);
      const typeMatch = (e.event_type || '').toLowerCase().includes(ql);
      const uaMatch = (e.user_agent || '').toLowerCase().includes(ql);
      const dataMatch = JSON.stringify(e.data || {}).toLowerCase().includes(ql);

      if (!ipMatch && !nameMatch && !typeMatch && !uaMatch && !dataMatch) {
        return false;
      }
    }
    return true;
  });

  return results.slice(0, limit);
}

// ── Wipe All Analytics Data ─────────────────────────────────────────────────
async function wipeAllData() {
  const db = getClient();
  let supabaseWiped = false;

  if (db) {
    try {
      const { error } = await db.from('analytics_events').delete().neq('id', 0);
      if (!error) supabaseWiped = true;
    } catch (err) {
      console.error('[Analytics] Wipe Supabase error:', err.message);
    }
  }

  try {
    if (fs.existsSync(LOCAL_EVENTS_FILE)) {
      fs.writeFileSync(LOCAL_EVENTS_FILE, '', 'utf8');
    }
  } catch (err) {
    console.error('[Analytics] Wipe local file error:', err.message);
  }

  return { ok: true, supabaseWiped };
}

module.exports = {
  logEvent,
  getStats,
  getUserActivity,
  searchEvents,
  extractClientInfo,
  getIpNames,
  getIpName,
  setIpName,
  deleteIpName,
  wipeAllData
};
