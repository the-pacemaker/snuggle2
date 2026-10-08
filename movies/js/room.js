/* =============================================
   SNUGGLE - Local Video Room
   WebSocket sync + GesturePlayer glue (v2)

   Messages (existing, unchanged):
     create_room / join_room / room_created / room_joined / user_joined / user_left / error
     yt_play / yt_pause / yt_seek / yt_load_video / yt_update_snapshot / yt_sync_snapshot
     yt_subtitle_offset { offset }

   Messages added in v2 (the server must relay them to the other user, see SERVER-NOTES.md):
     yt_subtitle_file   { id, name, index, total, chunk }   subtitle text, sent in chunks
     yt_tick            { id, position }                    gentle drift correction
     yt_load_video      now also carries { name, size, duration }
   ============================================= */
(function () {
  'use strict';

  // ── Config ──────────────────────────────────────
  const WS_URL = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;
  const SEEK_THRESHOLD_S = 2;      // ignore position differences smaller than this on play
  const DRIFT_THRESHOLD_S = 1.5;   // correct drift when the leader is further away than this
  const TICK_EVERY_MS = 5000;
  const SUB_CHUNK = 24000;         // characters per subtitle message (keeps every frame small)
  const SUB_MAX = 4000000;

  // ── State ────────────────────────────────────────
  let ws = null;
  let player = null;
  let usersCount = 0;
  let leaving = false;
  let reconnectAttempt = 0;
  let reconnectTimer = null;

  const clientId = Math.random().toString(36).slice(2, 10);
  let remoteState = null;          // last known state of the friend { pos, playing, t }
  let myFile = null;               // { name, size, duration }
  let friendFile = null;
  let lastLocalSeek = 0;
  let incomingSub = null;
  let subSendCounter = 0;

  // Pull room code from URL
  const params = new URLSearchParams(window.location.search);
  const ACTION = params.get('action'); // e.g. 'create'
  let ROOM_CODE = (params.get('code') || '').toUpperCase().trim();

  // ── DOM refs ─────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const roomCodeText = $('yt-room-code-text');
  const roomCodePill = $('yt-room-code-pill');
  const codeCopied = $('yt-code-copied');
  const statusDot = $('yt-status-dot');
  const statusLabel = $('yt-status-label');
  const nowPlayingLbl = $('yt-now-playing-label');
  const nowText = $('mv-now-text');
  const friendChip = $('mv-friend-file');
  const backBtn = $('mv-back');
  const toast = $('yt-toast');

  // ── "Expect" queue ────────────────────────────────
  // When *we* change the video because of a message from the friend, the browser fires
  // play / pause / seeked events a moment later. Each change we make registers an
  // expectation, and the matching event consumes it instead of being sent back.
  // Expectations expire after 2.5 s so a missing event can never block real input.
  function makeExpect() {
    const q = [];
    return {
      add() { q.push(Date.now() + 2500); },
      take() {
        const now = Date.now();
        while (q.length && q[0] < now) q.shift();
        if (!q.length) return false;
        q.shift();
        return true;
      }
    };
  }
  const ex = { play: makeExpect(), pause: makeExpect(), seek: makeExpect() };

  // ── Init ─────────────────────────────────────────
  function init() {
    document.body.classList.add('loaded');

    if (!ROOM_CODE && ACTION !== 'create') {
      window.location.href = '/movies/';
      return;
    }
    roomCodeText.textContent = ROOM_CODE || '------';

    initPlayer();
    setupEventListeners();
    connectWS();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // ── Player ────────────────────────────────────────
  const ready = () => player && !player.isSwapping && player.$.video.readyState > 0;

  function initPlayer() {
    player = new GesturePlayer(document.getElementById('gesture-player'), {
      title: '',
      allowLocalFile: true,
      allowLocalSubtitle: true,
    });

    const v = player.$.video;
    const c = player.container;
    let seekTimer = null;

    v.addEventListener('play', () => {
      if (player.isSwapping || ex.play.take()) return;
      sendWS({ type: 'yt_play', position: v.currentTime });
      sendSnapshotToServer();
    });

    v.addEventListener('pause', () => {
      if (player.isSwapping || ex.pause.take()) return;
      sendWS({ type: 'yt_pause', position: v.currentTime });
      sendSnapshotToServer();
    });

    v.addEventListener('seeked', () => {
      if (player.isSwapping || ex.seek.take()) return;
      lastLocalSeek = Date.now();
      // Several quick seeks (double-tap chains, scrubbing) collapse into one message.
      clearTimeout(seekTimer);
      seekTimer = setTimeout(() => {
        sendWS({ type: 'yt_seek', position: v.currentTime });
        sendSnapshotToServer();
      }, 120);
    });

    c.addEventListener('filechosen', (e) => {
      myFile = { name: e.detail.name, size: e.detail.size, duration: 0 };
      setNowPlaying(`Preparing ${e.detail.name}`);
      updateFriendChip();
    });

    c.addEventListener('videoready', (e) => {
      const d = e.detail;
      myFile = { name: d.name, size: d.size, duration: d.duration };
      setNowPlaying(d.name || 'Video ready');
      if (!d.resumed) {
        sendFileInfo();
        applyRemoteState();      // join whatever the friend is doing right now
      }
      updateFriendChip(true);
    });

    c.addEventListener('videoerror', () => setNowPlaying('Could not open the file'));

    // The user picked (or extracted) a subtitle: send it to the friend.
    c.addEventListener('subtitleload', (e) => sendSubtitle(e.detail.name, e.detail.text));

    // The user changed the timing (button, hold, keyboard or typed): share it.
    c.addEventListener('subtitleoffsetchange', (e) => queueOffset(e.detail));

    setInterval(() => {
      if (ready() && !v.paused) {
        sendSnapshotToServer();
      }
    }, 10000);

    // Drift correction: the user with the lexicographically smaller id is the "leader".
    setInterval(() => {
      if (ready() && !v.paused && usersCount > 1) sendWS({ type: 'yt_tick', id: clientId, position: v.currentTime });
    }, TICK_EVERY_MS);

    window.SnuggleRoom = { get player() { return player; }, send: sendWS };
  }

  // ── WebSocket ─────────────────────────────────────
  function connectWS() {
    clearTimeout(reconnectTimer);
    setStatus('connecting');

    try {
      ws = new WebSocket(WS_URL);
    } catch {
      setStatus('disconnected');
      scheduleReconnect();
      return;
    }

    ws.addEventListener('open', () => {
      reconnectAttempt = 0;
      if (ACTION === 'create' && !ROOM_CODE) {
        sendWS({ type: 'create_room' });
      } else {
        sendWS({ type: 'join_room', code: ROOM_CODE });
      }
    });

    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      handleMessage(msg);
    });

    ws.addEventListener('close', () => {
      setStatus('disconnected');
      usersCount = 0;
      scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      setStatus('disconnected');
    });
  }

  function scheduleReconnect() {
    if (leaving) return;
    clearTimeout(reconnectTimer);
    const delay = Math.min(10000, 1000 * Math.pow(2, reconnectAttempt++));   // 1s, 2s, 4s ... 10s
    reconnectTimer = setTimeout(connectWS, delay);
  }

  function updateConnectionStatus() {
    setStatus(usersCount > 1 ? 'connected' : 'waiting');
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'room_created': {
        ROOM_CODE = msg.code;
        roomCodeText.textContent = ROOM_CODE;
        usersCount = 1;
        updateConnectionStatus();
        // Update URL so it can be refreshed/copied
        const newUrl = new URL(window.location);
        newUrl.searchParams.delete('action');
        newUrl.searchParams.set('code', ROOM_CODE);
        window.history.replaceState({}, '', newUrl);
        if (window.snuggleTrack) snuggleTrack('room_create', { roomCode: ROOM_CODE, section: 'movies' });
        break;
      }

      case 'room_joined':
        usersCount = msg.usersCount || 1;
        updateConnectionStatus();
        if (window.snuggleTrack) snuggleTrack('room_join', { roomCode: ROOM_CODE, usersCount, section: 'movies' });
        break;

      case 'user_joined':
        usersCount = msg.usersCount || (usersCount + 1);
        updateConnectionStatus();
        showToast('Your friend joined the room 🎉');
        shareStateWithFriend();      // so a late joiner gets subtitles, timing and file info
        break;

      case 'user_left':
        usersCount = msg.usersCount || Math.max(1, usersCount - 1);
        updateConnectionStatus();
        friendFile = null;
        updateFriendChip();
        showToast('Your friend left the room.');
        break;

      case 'error':
        console.warn('[Snuggle WS]', msg.message);
        if (msg.message === 'Room not found') {
          window.location.href = '/movies/';
        }
        break;

      // ── Local Video sync events ──
      // Reusing 'yt_' prefix because the server already relays these types
      case 'yt_play':
        syncPlay(msg.position);
        break;
      case 'yt_pause':
        syncPause(msg.position);
        break;
      case 'yt_seek':
        syncSeek(msg.position);
        break;
      case 'yt_load_video':
        onFriendFile(msg);
        break;
      case 'yt_sync_snapshot':
        applySnapshot(msg.snapshot);
        break;
      case 'yt_subtitle_offset':
        syncSubtitleOffset(msg.offset);
        break;
      case 'yt_subtitle_file':
        receiveSubtitleChunk(msg);
        break;
      case 'yt_tick':
        onTick(msg);
        break;
    }
  }

  function sendWS(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
      return true;
    }
    return false;
  }

  // ── Play / pause / seek sync ──────────────────────
  function sendSnapshotToServer() {
    if (!ws || ws.readyState !== WebSocket.OPEN || !player) return;
    const v = player.$.video;
    const snapshot = {
      position: v.currentTime || 0,
      state: v.paused ? 2 : 1 // 1=PLAYING, 2=PAUSED
    };
    sendWS({ type: 'yt_update_snapshot', snapshot });
  }

  function seekTo(v, pos) {
    ex.seek.add();
    v.currentTime = pos;
  }

  function doPlay(v) {
    if (!v.paused) return;
    ex.play.add();
    const p = v.play();
    if (p && p.catch) p.catch(() => { ex.play.take(); showToast('Your friend pressed play. Tap play to join in.'); });
  }

  function doPause(v) {
    if (v.paused) return;
    ex.pause.add();
    v.pause();
  }

  // Bring our video to whatever the friend is currently doing.
  function applyRemoteState() {
    if (!remoteState || !ready()) return;
    const v = player.$.video;
    const age = Math.max(0, (Date.now() - remoteState.t) / 1000);
    const pos = remoteState.pos + (remoteState.playing ? age : 0);
    if (Math.abs(v.currentTime - pos) > SEEK_THRESHOLD_S) seekTo(v, pos);
    if (remoteState.playing) doPlay(v); else doPause(v);
  }

  function applySnapshot(snap) {
    if (!snap) return;
    remoteState = { pos: snap.position || 0, playing: snap.state === 1, t: snap.timestamp || Date.now() };
    applyRemoteState();       // if no file is loaded yet this is applied when it is ready
  }

  function syncPlay(position) {
    remoteState = { pos: position != null ? position : (remoteState ? remoteState.pos : 0), playing: true, t: Date.now() };
    if (!ready()) return;
    const v = player.$.video;
    if (position != null && Math.abs(v.currentTime - position) > SEEK_THRESHOLD_S) seekTo(v, position);
    doPlay(v);
  }

  function syncPause(position) {
    remoteState = { pos: position != null ? position : (remoteState ? remoteState.pos : 0), playing: false, t: Date.now() };
    if (!ready()) return;
    const v = player.$.video;
    doPause(v);
    if (position != null && Math.abs(v.currentTime - position) > 0.5) seekTo(v, position);
  }

  function syncSeek(position) {
    if (position == null) return;
    remoteState = { pos: position, playing: remoteState ? remoteState.playing : false, t: Date.now() };
    if (!ready()) return;
    const v = player.$.video;
    if (Math.abs(v.currentTime - position) > 0.05) seekTo(v, position);
  }

  function onTick(msg) {
    if (!msg || typeof msg.position !== 'number') return;
    remoteState = { pos: msg.position, playing: true, t: Date.now() };
    if (!ready() || !(msg.id < clientId)) return;               // only follow the leader
    const v = player.$.video;
    if (v.paused || Date.now() - lastLocalSeek < 3000) return;
    if (Math.abs(v.currentTime - msg.position) > DRIFT_THRESHOLD_S) seekTo(v, msg.position);
  }

  // ── Subtitle timing (shared) ──────────────────────
  let offTimer = null, offPending = null;

  function queueOffset(value) {
    offPending = value;
    if (offTimer) return;
    const fire = () => {
      if (offPending == null) { offTimer = null; return; }
      sendWS({ type: 'yt_subtitle_offset', offset: offPending });
      offPending = null;
      offTimer = setTimeout(() => { offTimer = null; if (offPending != null) fire(); }, 100);
    };
    fire();
  }

  function syncSubtitleOffset(offset) {
    if (typeof offset !== 'number' || !isFinite(offset)) return;
    player.setSubtitleOffset(offset);      // no 'emit': it must not bounce back
    const shown = (offset > 0 ? '+' : '') + player.getSubtitleOffset().toFixed(1);
    player.hud(`Friend set subtitle timing to ${shown} s`, 1500);
  }

  // ── Subtitle file (shared) ────────────────────────
  function sendSubtitle(name, text) {
    if (text.length > SUB_MAX) { showToast('That subtitle file is too big to share'); return; }
    if (usersCount < 2) return;                     // nobody to send to; shareStateWithFriend() covers later joiners
    const id = `${clientId}:${++subSendCounter}`;
    const total = Math.max(1, Math.ceil(text.length / SUB_CHUNK));
    for (let i = 0; i < total; i++) {
      sendWS({ type: 'yt_subtitle_file', id, name, index: i, total, chunk: text.slice(i * SUB_CHUNK, (i + 1) * SUB_CHUNK) });
    }
  }

  function receiveSubtitleChunk(m) {
    if (!m || typeof m.chunk !== 'string' || !m.total || m.index == null) return;
    if (!incomingSub || incomingSub.id !== m.id) incomingSub = { id: m.id, name: m.name, total: m.total, parts: [], got: 0 };
    if (incomingSub.parts[m.index] == null) { incomingSub.parts[m.index] = m.chunk; incomingSub.got++; }
    if (incomingSub.got < incomingSub.total) return;
    const { name, parts } = incomingSub;
    incomingSub = null;
    const ok = player.loadSubtitleText(parts.join(''), { name: name || 'Subtitles', source: 'remote' });
    if (ok) showToast(`Your friend shared subtitles: ${name || 'Subtitles'}`);
  }

  // Everything a friend who joins late needs (they only get what is relayed after they arrive).
  function shareStateWithFriend() {
    if (!player) return;
    const sub = player.getSubtitle();
    if (sub) {
      const id = `${clientId}:${++subSendCounter}`;
      const total = Math.max(1, Math.ceil(sub.text.length / SUB_CHUNK));
      for (let i = 0; i < total; i++) {
        sendWS({ type: 'yt_subtitle_file', id, name: sub.name, index: i, total, chunk: sub.text.slice(i * SUB_CHUNK, (i + 1) * SUB_CHUNK) });
      }
    }
    if (player.getSubtitleOffset() !== 0) sendWS({ type: 'yt_subtitle_offset', offset: player.getSubtitleOffset() });
    if (myFile && myFile.duration) sendFileInfo();
  }

  // ── File info: warn if the two files differ ───────
  function sendFileInfo() {
    if (!myFile) return;
    sendWS({ type: 'yt_load_video', name: myFile.name, size: myFile.size, duration: myFile.duration });
  }

  function onFriendFile(msg) {
    friendFile = { name: msg.name || '', size: msg.size || 0, duration: msg.duration || 0 };
    if (!myFile || !myFile.duration) showToast(`Your friend loaded ${friendFile.name || 'a video file'}. Please load the same one.`);
    updateFriendChip(true);
  }

  function filesMatch() {
    if (!myFile || !friendFile || !myFile.duration || !friendFile.duration) return null;
    return Math.abs(myFile.duration - friendFile.duration) <= 2;
  }

  let warnedMismatch = false;
  function updateFriendChip(announce) {
    if (!friendChip) return;
    const match = filesMatch();
    friendChip.className = 'mv-chip';
    if (!friendFile) { friendChip.hidden = true; return; }
    friendChip.hidden = false;
    if (match === null) {
      friendChip.textContent = `Friend picked ${friendFile.name || 'a file'}`;
      friendChip.classList.add('mv-chip--wait');
    } else if (match) {
      friendChip.textContent = 'Same video on both sides';
      friendChip.classList.add('mv-chip--ok');
      warnedMismatch = false;
    } else {
      const diff = Math.abs(myFile.duration - friendFile.duration);
      const m = Math.floor(diff / 60), s = Math.round(diff % 60);
      friendChip.textContent = `Different lengths (${m ? m + ' min ' : ''}${s} s apart). Check you picked the same file.`;
      friendChip.classList.add('mv-chip--warn');
      if (announce && !warnedMismatch) { warnedMismatch = true; showToast('Your videos have different lengths. Playback may not line up.'); }
    }
  }

  // ── Status Bar ────────────────────────────────────
  function setStatus(state) {
    statusDot.className = 'yt-status-dot';
    statusLabel.className = 'yt-status-label';

    if (state === 'connected') {
      statusDot.classList.add('yt-status-dot--connected');
      statusLabel.textContent = 'Connected';
    } else if (state === 'waiting') {
      statusDot.classList.add('yt-status-dot--waiting');
      statusLabel.textContent = 'Waiting';
    } else if (state === 'connecting') {
      statusDot.classList.add('yt-status-dot--connecting');
      statusLabel.textContent = 'Connecting…';
    } else {
      statusDot.classList.add('yt-status-dot--disconnected');
      statusLabel.textContent = 'Disconnected';
    }
  }

  function setNowPlaying(text) {
    if (nowText) nowText.textContent = text;
    else nowPlayingLbl.textContent = text;
  }

  // ── Room Code Share / Copy ────────────────────────
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise((resolve, reject) => {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy') ? resolve() : reject(new Error('copy failed')); } catch (e) { reject(e); }
      ta.remove();
    });
  }

  roomCodePill.addEventListener('click', async () => {
    const url = window.location.href;
    if (navigator.share) {
      try { await navigator.share({ title: 'Join my room', url }); return; } catch (e) { /* cancelled: fall through to copy */ }
    }
    copyText(url).then(() => {
      codeCopied.classList.add('visible');
      setTimeout(() => codeCopied.classList.remove('visible'), 2000);
    }).catch(() => showToast('Could not copy. Room code: ' + ROOM_CODE));
  });

  // ── Toast ─────────────────────────────────────────
  let toastTimer = null;
  function showToast(message) {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add('yt-toast--visible');
    toastTimer = setTimeout(() => toast.classList.remove('yt-toast--visible'), 3500);
  }

  // ── Event Listeners ───────────────────────────────
  function setupEventListeners() {
    const leave = () => {
      leaving = true;
      clearTimeout(reconnectTimer);
      try { if (ws) ws.close(1000); } catch (e) { /* ignore */ }
    };
    if (backBtn) backBtn.addEventListener('click', leave);
    window.addEventListener('pagehide', leave);
    window.addEventListener('pageshow', (e) => { if (e.persisted) { leaving = false; reconnectAttempt = 0; connectWS(); } });

    // Come back to a dead socket (phone woke up): reconnect straight away
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !leaving && (!ws || ws.readyState > 1)) {
        reconnectAttempt = 0;
        connectWS();
      }
    });
  }
})();
