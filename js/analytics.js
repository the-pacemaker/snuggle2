/* =============================================
   Snuggle — Client-Side Analytics Tracker
   
   Loaded on all pages. Sends events to /api/analytics/event
   Tracks: page views, YouTube watches, game sessions, 
           room events, search queries, time on page.
   ============================================= */

(function () {
  'use strict';

  const ENDPOINT = '/api/analytics/event';

  // Collect what we can from the client
  const clientMeta = {
    screen_width: window.screen?.width,
    screen_height: window.screen?.height,
    viewport_width: window.innerWidth,
    viewport_height: window.innerHeight,
    timezone: Intl?.DateTimeFormat()?.resolvedOptions()?.timeZone,
    language: navigator.language,
    platform: navigator.platform,
    cookiesEnabled: navigator.cookieEnabled,
    doNotTrack: navigator.doNotTrack,
    colorScheme: window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    connection: navigator.connection?.effectiveType || null,
  };

  function send(eventType, data = {}) {
    const payload = { eventType, data: { ...data, ...clientMeta } };
    // Use sendBeacon for reliability on page unload, fetch otherwise
    const json = JSON.stringify(payload);
    if (navigator.sendBeacon) {
      navigator.sendBeacon(ENDPOINT, new Blob([json], { type: 'application/json' }));
    } else {
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: json,
        keepalive: true
      }).catch(() => {}); // silently fail
    }
  }

  // ── Page view ────────────────────────────────────────────────────────
  const pageStart = Date.now();

  send('page_view', {
    page: document.title,
    path: window.location.pathname,
    search: window.location.search,
    referrer: document.referrer,
  });

  // Time on page — fires on unload
  window.addEventListener('pagehide', () => {
    send('page_leave', {
      path: window.location.pathname,
      timeOnPageSec: Math.round((Date.now() - pageStart) / 1000)
    });
  });

  // ── Expose tracker on window for other scripts to use ──────────────
  window.snuggleTrack = send;

  // ── YouTube watch tracking ───────────────────────────────────────────
  // Other scripts call: snuggleTrack('yt_watch', { videoId, title, roomCode })
  // snuggleTrack('yt_search', { query, resultsCount })

  // ── Game tracking ────────────────────────────────────────────────────
  // Other scripts call: snuggleTrack('game_play', { game, action, roomCode })

  // ── Room tracking ─────────────────────────────────────────────────────
  // Other scripts call: snuggleTrack('room_create', { roomCode })
  // snuggleTrack('room_join', { roomCode, usersCount })

})();
