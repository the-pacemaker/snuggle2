/* =============================================
   SNUGGLE — Room Invites & Global Presence Hub
   ============================================= */

(function (window) {
  'use strict';

  function getSessionId() {
    try {
      if (window.top && window.top !== window && window.top.__snuggleSessionId) {
        return window.top.__snuggleSessionId;
      }
    } catch (_) {}

    let id = null;
    try {
      id = sessionStorage.getItem('snuggle_session_id');
    } catch (_) {}

    if (!id) {
      id = 'usr_' + Math.random().toString(36).slice(2, 10);
      try {
        sessionStorage.setItem('snuggle_session_id', id);
      } catch (_) {}
    }

    try {
      if (window.top) window.top.__snuggleSessionId = id;
    } catch (_) {}

    return id;
  }

  let lastSentInviteTime = 0;
  function markInviteSent() {
    lastSentInviteTime = Date.now();
    try {
      if (window.top) window.top.__snuggleLastInviteSent = Date.now();
    } catch (_) {}
  }

  function wasInviteSentByMe() {
    const topTime = (() => {
      try { return window.top && window.top.__snuggleLastInviteSent; } catch (_) { return 0; }
    })() || 0;
    return (Date.now() - Math.max(lastSentInviteTime, topTime)) < 4000;
  }

  function getActivityIcon(activity) {
    const act = (activity || '').toLowerCase();
    if (act.includes('youtube')) {
      return `<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="#f4a261" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22.54 6.42a2.78 2.78 0 0 0-1.94-2C18.88 4 12 4 12 4s-6.88 0-8.6.46a2.78 2.78 0 0 0-1.94 2A29 29 0 0 0 1 11.75a29 29 0 0 0 .46 5.33A2.78 2.78 0 0 0 3.4 19.1c1.72.46 8.6.46 8.6.46s6.88 0 8.6-.46a2.78 2.78 0 0 0 1.94-2 29 29 0 0 0 .46-5.25 29 29 0 0 0-.46-5.43z"/><polygon points="9.75 15.02 15.5 11.75 9.75 8.48 9.75 15.02" fill="#f4a261"/></svg>`;
    }
    if (act.includes('movie')) {
      return `<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="#f4a261" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><polygon points="10 11 10 17 15 14 10 11" fill="#f4a261"/></svg>`;
    }
    if (act.includes('call') || act.includes('video')) {
      return `<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="#f4a261" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7" fill="#f4a261"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>`;
    }
    // Games (Wordle, Connections, Strands, etc.)
    return `<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="#f4a261" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><line x1="6" y1="12" x2="10" y2="12"/><line x1="8" y1="10" x2="8" y2="14"/><line x1="15" y1="13" x2="15.01" y2="13"/><line x1="18" y1="11" x2="18.01" y2="11"/></svg>`;
  }

  function showInviteModal(data) {
    if (!data || !data.url) return;
    const myId = getSessionId();
    if (data.from && data.from === myId) return;
    if (data.senderId && data.senderId === myId) return;
    if (wasInviteSentByMe()) return;
    const activity = data.activity || 'an activity';
    const targetUrl = data.url;

    let overlay = document.getElementById('snuggle-invite-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'snuggle-invite-overlay';
      overlay.style.cssText = `
        position: fixed;
        inset: 0;
        z-index: 100000;
        background: rgba(0, 0, 0, 0.65);
        backdrop-filter: blur(6px);
        -webkit-backdrop-filter: blur(6px);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
        opacity: 0;
        transition: opacity 0.25s ease-out;
      `;
      document.body.appendChild(overlay);
    }

    const iconHtml = getActivityIcon(activity);

    overlay.innerHTML = `
      <div id="snuggle-invite-card" style="
        background: #523b20;
        background: linear-gradient(155deg, #5c4224 0%, #3e2810 100%);
        border: 1px solid rgba(244, 162, 97, 0.35);
        border-radius: 18px;
        padding: 28px 24px;
        max-width: 360px;
        width: 100%;
        text-align: center;
        box-shadow: 0 16px 40px rgba(0,0,0,0.65), 0 0 0 1px rgba(255,255,255,0.06);
        color: #ffffff;
        transform: scale(0.92);
        transition: transform 0.25s cubic-bezier(0.175, 0.885, 0.32, 1.275);
      ">
        <div style="
          width: 58px;
          height: 58px;
          border-radius: 50%;
          background: rgba(244, 162, 97, 0.15);
          display: flex;
          align-items: center;
          justify-content: center;
          margin: 0 auto 14px;
          border: 1px solid rgba(244, 162, 97, 0.3);
        ">
          ${iconHtml}
        </div>
        <h3 style="
          margin: 0 0 8px;
          font-size: 20px;
          font-weight: 700;
          color: #f4a261;
          letter-spacing: 0.02em;
        ">Friend Invite!</h3>
        <p style="
          margin: 0 0 24px;
          font-size: 15px;
          color: rgba(255, 255, 255, 0.9);
          line-height: 1.45;
        ">Your friend invited you to join <strong style="color: #fff; font-weight: 700;">${activity}</strong>!</p>
        <div style="display: flex; gap: 12px; justify-content: center;">
          <button type="button" id="snuggle-invite-decline" style="
            flex: 1;
            padding: 11px 16px;
            border-radius: 10px;
            font-weight: 600;
            font-size: 14px;
            cursor: pointer;
            background: rgba(255, 255, 255, 0.08);
            border: 1px solid rgba(255, 255, 255, 0.18);
            color: rgba(255, 255, 255, 0.85);
            transition: background 0.18s;
          ">Decline</button>
          <button type="button" id="snuggle-invite-join" style="
            flex: 1;
            padding: 11px 16px;
            border-radius: 10px;
            font-weight: 700;
            font-size: 14px;
            cursor: pointer;
            background: #e76f51;
            border: none;
            color: #ffffff;
            box-shadow: 0 4px 12px rgba(231, 111, 81, 0.35);
            transition: background 0.18s, transform 0.12s;
          ">Join</button>
        </div>
      </div>
    `;

    overlay.style.display = 'flex';
    requestAnimationFrame(() => {
      overlay.style.opacity = '1';
      const card = document.getElementById('snuggle-invite-card');
      if (card) card.style.transform = 'scale(1)';
    });

    function close() {
      overlay.style.opacity = '0';
      const card = document.getElementById('snuggle-invite-card');
      if (card) card.style.transform = 'scale(0.92)';
      setTimeout(() => {
        overlay.style.display = 'none';
      }, 250);
    }

    const declineBtn = document.getElementById('snuggle-invite-decline');
    const joinBtn = document.getElementById('snuggle-invite-join');

    declineBtn.onclick = close;
    joinBtn.onclick = () => {
      close();
      window.location.href = targetUrl;
    };

    overlay.onclick = (e) => {
      if (e.target === overlay) close();
    };

    // Close on Escape key
    const onKeyDown = (e) => {
      if (e.key === 'Escape' && overlay.style.display === 'flex') {
        close();
        document.removeEventListener('keydown', onKeyDown);
      }
    };
    document.addEventListener('keydown', onKeyDown);
  }

  // --- Hub presence for pages like home.html & games/index.html ---
  let hubWs = null;
  let hubPingTimer = null;
  let hubReconnectTimer = null;

  function connectHub(roomCode) {
    if (!roomCode) return;
    clearTimeout(hubReconnectTimer);
    clearInterval(hubPingTimer);

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    try {
      hubWs = new WebSocket(wsUrl);
    } catch (e) {
      console.warn('[SnuggleInvite] WebSocket connect error:', e);
      return;
    }

    hubWs.onopen = () => {
      const sid = getSessionId();
      hubWs.send(JSON.stringify({ type: 'join_room', code: roomCode, from: sid, sessionId: sid }));
      hubPingTimer = setInterval(() => {
        if (hubWs && hubWs.readyState === 1) {
          hubWs.send(JSON.stringify({ type: 'ping' }));
        }
      }, 25000);
    };

    hubWs.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg && msg.type === 'room_invite') {
          showInviteModal(msg);
        }
      } catch (e) {}
    };

    hubWs.onclose = () => {
      clearInterval(hubPingTimer);
      hubReconnectTimer = setTimeout(() => connectHub(roomCode), 3000);
    };
  }

  window.addEventListener('beforeunload', () => {
    if (hubWs) {
      try { hubWs.close(); } catch (e) {}
    }
  });

  window.SnuggleInvite = {
    showInviteModal,
    connectHub,
    getSessionId,
    markInviteSent
  };
})(window);
