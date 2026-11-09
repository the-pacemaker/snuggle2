/* =============================================
   Snuggle — Enhanced Client-Side Analytics Tracker
   
   Loaded on all pages. Sends events to /api/analytics/event
   Tracks:
     • Persistent visitor identity & session IDs
     • Page views & active duration (time-on-page)
     • Video & movie watches (YouTube & local video)
     • Game sessions (Wordle, Connections, Strands, Contra, Battle City)
     • Call sessions (start, connect, duration, mic/camera toggles)
     • Room activity (create, join, leave)
     • Navigation & activity selections
   ============================================= */

(function () {
  'use strict';

  const ENDPOINT = '/api/analytics/event';

  // ── Persistent Visitor Identity ──────────────────────────────────────────
  function getOrCreateVisitorId() {
    try {
      let vid = localStorage.getItem('snuggle_visitor_id');
      if (!vid) {
        vid = 'v_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
        localStorage.setItem('snuggle_visitor_id', vid);
      }
      return vid;
    } catch (_) {
      return 'v_anon_' + Math.random().toString(36).slice(2, 9);
    }
  }

  // ── Session Identity (resets per browser session) ────────────────────────
  function getOrCreateSessionId() {
    try {
      let sid = sessionStorage.getItem('snuggle_session_id');
      if (!sid) {
        sid = 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
        sessionStorage.setItem('snuggle_session_id', sid);
      }
      return sid;
    } catch (_) {
      return 's_anon_' + Math.random().toString(36).slice(2, 8);
    }
  }

  const VISITOR_ID = getOrCreateVisitorId();
  const SESSION_ID = getOrCreateSessionId();

  // ── Client Metadata ───────────────────────────────────────────────────────
  function getClientMeta() {
    return {
      visitor_id: VISITOR_ID,
      session_id: SESSION_ID,
      screen_width: window.screen?.width || window.innerWidth || null,
      screen_height: window.screen?.height || window.innerHeight || null,
      viewport_width: window.innerWidth || null,
      viewport_height: window.innerHeight || null,
      device_pixel_ratio: window.devicePixelRatio || 1,
      timezone: Intl?.DateTimeFormat()?.resolvedOptions()?.timeZone || null,
      language: navigator.language || null,
      platform: navigator.platform || null,
      cookiesEnabled: navigator.cookieEnabled ?? true,
      colorScheme: window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      connection: navigator.connection?.effectiveType || null,
    };
  }

  // ── Send Event ────────────────────────────────────────────────────────────
  function send(eventType, data = {}) {
    if (!eventType || typeof eventType !== 'string') return;

    // Detect room code if not provided
    const roomCode = data.roomCode || 
      new URLSearchParams(window.location.search).get('code') || 
      sessionStorage.getItem('snuggle_room_code') || 
      localStorage.getItem('snuggle_room_code') || 
      null;

    const payload = {
      eventType,
      data: {
        ...getClientMeta(),
        path: window.location.pathname,
        roomCode: roomCode || undefined,
        ...data,
      }
    };

    const json = JSON.stringify(payload);

    try {
      if (navigator.sendBeacon) {
        const blob = new Blob([json], { type: 'application/json' });
        const success = navigator.sendBeacon(ENDPOINT, blob);
        if (success) return;
      }
    } catch (_) {}

    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: json,
      keepalive: true
    }).catch(() => {});
  }

  // ── Page View Tracking ────────────────────────────────────────────────────
  const pageStart = Date.now();
  let lastHeartbeat = pageStart;

  send('page_view', {
    page: document.title || window.location.pathname,
    path: window.location.pathname,
    search: window.location.search || '',
    referrer: document.referrer || '',
  });

  // ── Page Leave Tracking (time-on-page) ─────────────────────────────────────
  let pageLeaveSent = false;
  function sendPageLeave() {
    if (pageLeaveSent) return;
    pageLeaveSent = true;
    const timeOnPageSec = Math.round((Date.now() - pageStart) / 1000);
    send('page_leave', {
      page: document.title || window.location.pathname,
      path: window.location.pathname,
      timeOnPageSec
    });
  }

  window.addEventListener('pagehide', sendPageLeave);
  window.addEventListener('beforeunload', sendPageLeave);

  // ── Periodic Heartbeat for Long Sessions (every 4 minutes) ────────────────
  setInterval(() => {
    if (document.visibilityState === 'visible') {
      const activeSec = Math.round((Date.now() - lastHeartbeat) / 1000);
      lastHeartbeat = Date.now();
      send('page_heartbeat', {
        page: document.title || window.location.pathname,
        path: window.location.pathname,
        activeDurationSec: activeSec,
        totalTimeOnPageSec: Math.round((Date.now() - pageStart) / 1000)
      });
    }
  }, 4 * 60 * 1000);

  // ── Automatic Activity Selection Tracking (home page nav buttons) ─────────
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.nav-btn, a[href^="/movies"], a[href^="/youtube"], a[href^="/games"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const label = btn.querySelector('.nav-btn__label')?.textContent?.trim() || btn.textContent?.trim() || btn.id;
        send('activity_select', {
          activity: label,
          href: btn.getAttribute('href'),
          id: btn.id
        });
      });
    });
  });

  // ── Public API ────────────────────────────────────────────────────────────
  window.snuggleTrack = send;
  window.snuggleTrack.visitorId = VISITOR_ID;
  window.snuggleTrack.sessionId = SESSION_ID;

  window.snuggleTrack.ytWatch = function (videoId, title, roomCode) {
    send('yt_watch', { videoId, title, roomCode });
  };

  window.snuggleTrack.movieWatch = function (fileName, duration, roomCode, extra = {}) {
    send('movie_watch', { fileName, duration, roomCode, ...extra });
  };

  window.snuggleTrack.gamePlay = function (game, action, roomCode, extra = {}) {
    send('game_play', { game, action, roomCode, ...extra });
  };

  window.snuggleTrack.callEvent = function (action, roomCode, extra = {}) {
    send('call_event', { action, roomCode, ...extra });
  };

  window.snuggleTrack.roomEvent = function (action, roomCode, usersCount = null, extra = {}) {
    send(action.startsWith('room_') ? action : `room_${action}`, { roomCode, usersCount, ...extra });
  };

})();
