/* =============================================
   SNUGGLE — Analytics Module
   
   Handles all event tracking and data collection.
   Stores events to Supabase (PostgreSQL).
   ============================================= */

const { createClient } = require('@supabase/supabase-js');

let supabase = null;

function getClient() {
  if (supabase) return supabase;
  const url = 'https://gmdljmtmbaudmkgmahvs.supabase.co'; // Hardcoded as requested
  const key = 'sb_publishable_enaBOcAmbXRYQokSoLl94w_Vxapdfhs'; // Hardcoded as requested
  if (!url || !key) {
    console.warn('[Analytics] Supabase env vars not set — analytics disabled');
    return null;
  }
  supabase = createClient(url, key);
  return supabase;
}

/**
 * Log an analytics event.
 * @param {string} eventType  - e.g. 'page_view', 'yt_watch', 'game_play', 'room_join', etc.
 * @param {object} data       - arbitrary event payload
 * @param {object} req        - Express request object (for IP & UA extraction)
 */
async function logEvent(eventType, data = {}, req = null) {
  const db = getClient();
  if (!db) return;

  const clientInfo = req ? extractClientInfo(req) : {};

  const record = {
    event_type: eventType,
    data: data,
    ...clientInfo,
    created_at: new Date().toISOString()
  };

  try {
    const { error } = await db.from('analytics_events').insert(record);
    if (error) console.error('[Analytics] Insert error:', error.message);
  } catch (err) {
    console.error('[Analytics] Unexpected error:', err.message);
  }
}

/**
 * Extract device/client info from an Express request.
 */
function extractClientInfo(req) {
  const ua = req.headers['user-agent'] || '';
  const ip = (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    'unknown'
  );

  return {
    ip_address: ip,
    user_agent: ua,
    referrer: req.headers['referer'] || req.headers['referrer'] || null,
    country: req.headers['cf-ipcountry'] || null, // Cloudflare header if behind CF
    device_type: detectDevice(ua),
    browser: detectBrowser(ua),
    os: detectOS(ua),
    language: req.headers['accept-language']?.split(',')[0] || null,
    screen_width: null, // filled client-side via /api/analytics/event
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
  if (/opr\//i.test(ua)) return 'Opera';
  if (/chrome/i.test(ua)) return 'Chrome';
  if (/firefox/i.test(ua)) return 'Firefox';
  if (/safari/i.test(ua)) return 'Safari';
  if (/msie|trident/i.test(ua)) return 'IE';
  return 'Other';
}

function detectOS(ua) {
  if (/windows/i.test(ua)) return 'Windows';
  if (/mac os/i.test(ua)) return 'macOS';
  if (/android/i.test(ua)) return 'Android';
  if (/iphone|ipad|ipod/i.test(ua)) return 'iOS';
  if (/linux/i.test(ua)) return 'Linux';
  return 'Other';
}

/**
 * Query analytics data for the stats dashboard.
 */
async function getStats() {
  const db = getClient();
  if (!db) return null;

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const startOf7Days = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const startOf30Days = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  try {
    // Fetch recent events for tables (last 500)
    const { data: recentEvents, error: recentErr } = await db
      .from('analytics_events')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(500);

    if (recentErr) throw recentErr;

    // Fetch today's events
    const { data: todayEvents, error: todayErr } = await db
      .from('analytics_events')
      .select('*')
      .gte('created_at', startOfToday);

    if (todayErr) throw todayErr;

    // Fetch 7-day events
    const { data: week7Events, error: week7Err } = await db
      .from('analytics_events')
      .select('event_type, created_at, ip_address, device_type, browser, os, data')
      .gte('created_at', startOf7Days);

    if (week7Err) throw week7Err;

    // Fetch 30-day events
    const { data: month30Events, error: month30Err } = await db
      .from('analytics_events')
      .select('event_type, created_at, ip_address, device_type, browser, os')
      .gte('created_at', startOf30Days);

    if (month30Err) throw month30Err;

    return {
      recentEvents: recentEvents || [],
      todayEvents: todayEvents || [],
      week7Events: week7Events || [],
      month30Events: month30Events || []
    };
  } catch (err) {
    console.error('[Analytics] getStats error:', err.message);
    return null;
  }
}

/**
 * Search analytics events.
 */
async function searchEvents({ query, eventType, dateFrom, dateTo, limit = 100 }) {
  const db = getClient();
  if (!db) return [];

  try {
    let q = db
      .from('analytics_events')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (eventType && eventType !== 'all') q = q.eq('event_type', eventType);
    if (dateFrom) q = q.gte('created_at', dateFrom);
    if (dateTo) q = q.lte('created_at', dateTo);

    const { data, error } = await q;
    if (error) throw error;

    // Client-side text search on IP, UA, or data JSON
    if (query && data) {
      const ql = query.toLowerCase();
      return data.filter(e =>
        (e.ip_address || '').toLowerCase().includes(ql) ||
        (e.user_agent || '').toLowerCase().includes(ql) ||
        JSON.stringify(e.data || {}).toLowerCase().includes(ql) ||
        (e.event_type || '').toLowerCase().includes(ql)
      );
    }

    return data || [];
  } catch (err) {
    console.error('[Analytics] searchEvents error:', err.message);
    return [];
  }
}

module.exports = { logEvent, getStats, searchEvents, extractClientInfo };
