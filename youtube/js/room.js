/* =============================================
   SNUGGLE — YouTube Room
   WebSocket sync, YouTube IFrame Player API,
   Queue management, Video search & URL paste
   ============================================= */

'use strict';

// ── Config ──────────────────────────────────────
const WS_URL         = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;
const API_KEY_STORE  = 'snuggle_yt_apikey';
const DEFAULT_API_KEY = 'AIzaSyDW-F19zZDYN8e8mzmbh-CLqqXndNUOFu0';
const YT_SEARCH_URL  = 'https://www.googleapis.com/youtube/v3/search';
const YT_VIDEO_URL   = 'https://www.googleapis.com/youtube/v3/videos';
const SEARCH_DEBOUNCE_MS = 500;
const SEEK_THRESHOLD_S   = 2; // Only broadcast seek if diff > 2s
const SYNC_GUARD_MS      = 1500; // Time to suppress re-broadcast after receiving sync events
const SEEK_POLL_MS       = 500;  // Polling interval for detecting user seeks

// ── State ────────────────────────────────────────
let ws          = null;
let player      = null;       // YouTube IFrame Player instance
let playerReady = false;
let syncGuardCount = 0;       // Counter-based guard: >0 means suppress re-broadcast
let usersCount  = 0;
let pendingSnapshot = null;
let pendingLoad     = null;   // Deferred loadQueueItem when player not ready yet

let queue       = [];         // Array of { videoId, title, thumbnail }
let currentIdx  = -1;         // Currently playing queue index

let currentSearchQuery = '';
let nextSearchPageToken = null;
let searchTimer = null;
let lastKnownPos = 0;         // For seek detection via polling
let seekPollTimer = null;

const urlParams = new URLSearchParams(window.location.search);
const urlCode = urlParams.get('code');
if (urlCode) {
  sessionStorage.setItem('snuggle_room_code', urlCode.toUpperCase().trim());
}

let ROOM_CODE = sessionStorage.getItem('snuggle_room_code');
if (!ROOM_CODE) {
  window.location.href = '/welcome.html';
} else if (!urlCode || urlCode.toUpperCase().trim() !== ROOM_CODE) {
  urlParams.set('code', ROOM_CODE);
  window.history.replaceState({}, '', `${window.location.pathname}?${urlParams.toString()}`);
}

// ── DOM refs ─────────────────────────────────────
const roomCodeText   = document.getElementById('yt-room-code-text');
const roomCodePill   = document.getElementById('yt-room-code-pill');
const codeCopied     = document.getElementById('yt-code-copied');
const statusDot      = document.getElementById('yt-status-dot');
const statusLabel    = document.getElementById('yt-status-label');
const playerEmpty    = document.getElementById('yt-player-empty');
const nowPlayingBar  = document.getElementById('yt-now-playing');
const nowPlayingLbl  = document.getElementById('yt-now-playing-label');
const prevBtn        = document.getElementById('yt-prev-btn');
const nextBtn        = document.getElementById('yt-next-btn');
const queueList      = document.getElementById('yt-queue-list');
const queueCount     = document.getElementById('yt-queue-count');
const searchInput    = document.getElementById('yt-search-input');
const searchClear    = document.getElementById('yt-search-clear');
const urlInput       = document.getElementById('yt-url-input');
const urlAddBtn      = document.getElementById('yt-url-add-btn');
const resultsGrid    = document.getElementById('yt-results-grid');
const resultsLoading = document.getElementById('yt-results-loading');
const resultsEmpty   = document.getElementById('yt-results-empty');
const loadMoreBtn    = document.getElementById('yt-load-more-btn');
const toast          = document.getElementById('yt-toast');

// API key sheet (in room)
const roomApikeySheet   = document.getElementById('yt-room-apikey-sheet');
const roomApikeyInput   = document.getElementById('yt-room-apikey-input');
const roomApikeyCancel  = document.getElementById('yt-room-apikey-cancel');
const roomApikeySave    = document.getElementById('yt-room-apikey-save');
const roomApikeyBack    = document.getElementById('yt-room-apikey-backdrop');

// ── Sync Guard Helpers ───────────────────────────
// Use a counter instead of a boolean so overlapping sync events don't
// prematurely clear the guard when the first timer fires.
function enterSyncGuard() {
  syncGuardCount++;
  setTimeout(() => {
    syncGuardCount = Math.max(0, syncGuardCount - 1);
  }, SYNC_GUARD_MS);
}

function isSyncing() {
  return syncGuardCount > 0;
}

// ── Init ─────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.body.classList.add('loaded');

  roomCodeText.textContent = ROOM_CODE || '------';
  setupEventListeners();
  connectWS();
  updateApiKeyUI();
});

// ── YouTube IFrame API ───────────────────────────
// Creates the YT player. Called either by YouTube's callback
// or by our fallback check below.
function initYTPlayer() {
  // Guard: only create once
  if (player) return;

  player = new YT.Player('yt-player', {
    height: '100%',
    width: '100%',
    playerVars: {
      autoplay: 0,
      controls: 1,
      rel: 0,
      modestbranding: 1,
      playsinline: 1,
      enablejsapi: 1,
      origin: window.location.origin
    },
    events: {
      onReady: onPlayerReady,
      onStateChange: onPlayerStateChange,
      onError: onPlayerError,
    }
  });
}

// Called by YouTube's iframe_api script when ready
window.onYouTubeIframeAPIReady = function () {
  initYTPlayer();
};

// ── CRITICAL: handle cached API race condition ───
// If the YouTube IFrame API script was cached from a previous load,
// it may have already fired onYouTubeIframeAPIReady BEFORE this script
// defined the callback. In that case the player never gets created.
// This check handles that race condition.
if (typeof YT !== 'undefined' && YT.loaded) {
  // API already loaded — init immediately (on next tick to be safe)
  setTimeout(initYTPlayer, 0);
}

function onPlayerReady() {
  playerReady = true;

  // Start seek detection polling
  startSeekPolling();

  // Apply any deferred state
  if (pendingSnapshot) {
    applySnapshot(pendingSnapshot);
    pendingSnapshot = null;
  } else if (pendingLoad) {
    loadQueueItem(pendingLoad.index, false, pendingLoad.position);
    pendingLoad = null;
  }
}

function onPlayerStateChange(event) {
  if (isSyncing()) return;

  const state = event.data;
  const pos   = player.getCurrentTime ? player.getCurrentTime() : 0;

  if (state === YT.PlayerState.PLAYING) {
    // Update lastKnownPos so the seek detector doesn't fire on natural play start
    lastKnownPos = pos;
    sendWS({ type: 'yt_play', position: pos });
    sendSnapshotToServer();
  } else if (state === YT.PlayerState.PAUSED) {
    sendWS({ type: 'yt_pause', position: pos });
    sendSnapshotToServer();
  } else if (state === YT.PlayerState.ENDED) {
    // Auto-advance to next video in queue
    if (currentIdx < queue.length - 1) {
      playNext(/* broadcast= */ true);
    }
  }
  // BUFFERING (3) and CUED (5) are intentionally not broadcast
}

function onPlayerError(event) {
  console.error('[Snuggle YT] Player error code:', event.data);
  // Error codes: 2 = invalid param, 5 = HTML5 error, 100 = not found,
  // 101/150 = not allowed to be embedded (common with Shorts)
  if (event.data === 101 || event.data === 150) {
    showToast('This video can\'t be embedded. Skipping…');
  } else {
    showToast('Video failed to load. Skipping…');
  }

  // Try to advance to next video
  if (currentIdx < queue.length - 1) {
    setTimeout(() => playNext(true), 1500);
  }
}

// ── Seek Detection via Polling ───────────────────
// The YouTube IFrame Player API has no `seeked` event.
// We detect seeks by polling: if the position jumps more than
// SEEK_THRESHOLD_S from what we'd expect, the user sought.
function startSeekPolling() {
  if (seekPollTimer) clearInterval(seekPollTimer);
  seekPollTimer = setInterval(() => {
    if (!playerReady || !player.getPlayerState || isSyncing()) return;
    const state = player.getPlayerState();
    if (state !== YT.PlayerState.PLAYING && state !== YT.PlayerState.PAUSED) return;

    const currentPos = player.getCurrentTime();
    // Expected position: lastKnownPos + elapsed time (for playing) or same (for paused)
    const elapsed = state === YT.PlayerState.PLAYING ? SEEK_POLL_MS / 1000 : 0;
    const expectedPos = lastKnownPos + elapsed;
    const diff = Math.abs(currentPos - expectedPos);

    if (diff > SEEK_THRESHOLD_S) {
      // User seeked
      sendWS({ type: 'yt_seek', position: currentPos });
      sendSnapshotToServer();
    }

    lastKnownPos = currentPos;
  }, SEEK_POLL_MS);
}

// Periodic snapshot for long-running sessions
setInterval(() => {
  if (playerReady && player.getPlayerState && player.getPlayerState() === 1) {
    sendSnapshotToServer();
  }
}, 10000);

// ── WebSocket ─────────────────────────────────────
function connectWS() {
  setStatus('connecting');

  try {
    ws = new WebSocket(WS_URL);
  } catch {
    setStatus('disconnected');
    return;
  }

  ws.addEventListener('open', () => {
    sendWS({ type: 'join_room', code: ROOM_CODE });
  });

  ws.addEventListener('message', (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    handleMessage(msg);
  });

  ws.addEventListener('close', () => {
    setStatus('disconnected');
    // Attempt reconnect after 3s
    setTimeout(connectWS, 3000);
  });

  ws.addEventListener('error', () => {
    setStatus('disconnected');
  });
}

function updateConnectionStatus() {
  if (usersCount > 1) {
    setStatus('connected');
  } else {
    setStatus('waiting');
  }
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'room_created':
      ROOM_CODE = msg.code;
      localStorage.setItem('snuggle_last_room_code', ROOM_CODE);
      roomCodeText.textContent = ROOM_CODE;
      usersCount = 1;
      updateConnectionStatus();
      // Update URL so it can be refreshed/copied
      const newUrl = new URL(window.location);
      newUrl.searchParams.delete('action');
      newUrl.searchParams.set('code', ROOM_CODE);
      window.history.replaceState({}, '', newUrl);
      if (window.snuggleTrack) snuggleTrack('room_create', { roomCode: ROOM_CODE, section: 'youtube' });
      break;

    case 'room_joined':
      localStorage.setItem('snuggle_last_room_code', ROOM_CODE);
      usersCount = msg.usersCount || 1;
      updateConnectionStatus();
      if (window.snuggleTrack) snuggleTrack('room_join', { roomCode: ROOM_CODE, usersCount, section: 'youtube' });
      break;

    case 'user_joined':
      usersCount = msg.usersCount || (usersCount + 1);
      updateConnectionStatus();
      showToast('Your friend joined the room 🎉');
      // Send a fresh snapshot so the new user gets our latest state
      sendSnapshotToServer();
      break;

    case 'user_left':
      usersCount = msg.usersCount || Math.max(1, usersCount - 1);
      updateConnectionStatus();
      showToast('Your friend left the room.');
      break;

    case 'error':
      console.warn('[Snuggle WS]', msg.message);
      if (msg.message === 'Room not found') {
        window.location.href = '/youtube/';
      }
      break;

    // ── YouTube sync events ──
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
      handleRemoteLoadVideo(msg);
      break;
    case 'yt_queue_add':
      addToQueue(msg.video, /* broadcast= */ false);
      break;
    case 'yt_queue_remove':
      removeFromQueue(msg.index, /* broadcast= */ false);
      break;
    case 'yt_next':
      playNext(/* broadcast= */ false);
      break;
    case 'yt_prev':
      playPrev(/* broadcast= */ false);
      break;
    case 'yt_sync_snapshot':
      if (!playerReady) {
        pendingSnapshot = msg.snapshot;
        pendingLoad = null; // Snapshot supersedes any pending load
        // Still render the queue immediately so the UI doesn't look empty
        queue = msg.snapshot.queue || [];
        currentIdx = msg.snapshot.currentIdx !== undefined ? msg.snapshot.currentIdx : -1;
        renderQueue();
        // Hide the empty placeholder if there's a video to show
        if (currentIdx >= 0 && currentIdx < queue.length) {
          playerEmpty.style.display = 'none';
          const video = queue[currentIdx];
          nowPlayingLbl.innerHTML = `
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            ${escapeHtml(video.title)}
          `;
          updateNavButtons();
        }
      } else {
        applySnapshot(msg.snapshot);
      }
      break;
  }
}

// Handle remote yt_load_video: ensures the video exists in our queue
// before trying to play it, solving the race where yt_load_video
// arrives before yt_queue_add.
function handleRemoteLoadVideo(msg) {
  const idx = msg.index;
  const pos = msg.position || 0;

  // If the message includes the video data and our queue doesn't have it yet,
  // add it to the queue first. This fixes the race condition where yt_load_video
  // arrives before yt_queue_add.
  if (msg.video && (idx >= queue.length || (queue[idx] && queue[idx].videoId !== msg.video.videoId))) {
    // Ensure queue is large enough
    while (queue.length <= idx) {
      queue.push(null);
    }
    queue[idx] = msg.video;
    // Remove any null placeholders
    queue = queue.filter(v => v !== null);
    renderQueue();
  }

  if (!playerReady) {
    // Defer until player is ready
    pendingLoad = { index: idx, position: pos };
    // Still update UI immediately
    if (idx >= 0 && idx < queue.length) {
      currentIdx = idx;
      const video = queue[currentIdx];
      playerEmpty.style.display = 'none';
      nowPlayingLbl.innerHTML = `
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        ${escapeHtml(video.title)}
      `;
      updateNavButtons();
      renderQueue();
    }
  } else {
    loadQueueItem(idx, false, pos);
  }
}

function sendWS(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// ── Sync Functions ────────────────────────────────
function sendSnapshotToServer() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const snapshot = {
    queue,
    currentIdx,
    videoId: currentIdx >= 0 && currentIdx < queue.length ? queue[currentIdx].videoId : null,
    position: playerReady && player.getCurrentTime ? player.getCurrentTime() : 0,
    state: playerReady && player.getPlayerState ? player.getPlayerState() : -1
  };
  sendWS({ type: 'yt_update_snapshot', snapshot });
}

function applySnapshot(snap) {
  if (!snap) return;
  queue = snap.queue || [];
  currentIdx = snap.currentIdx !== undefined ? snap.currentIdx : -1;
  renderQueue();

  if (currentIdx >= 0 && currentIdx < queue.length) {
    const video = queue[currentIdx];
    const elapsedSec = snap.timestamp ? Math.max(0, (Date.now() - snap.timestamp) / 1000) : 0;

    let pos = snap.position || 0;
    if (snap.state === 1) { // 1 = PLAYING
      pos += elapsedSec;
    }

    // Hide the empty placeholder
    playerEmpty.style.display = 'none';
    nowPlayingLbl.innerHTML = `
      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>
      ${escapeHtml(video.title)}
    `;
    updateNavButtons();

    if (playerReady) {
      enterSyncGuard();

      // Update lastKnownPos so seek detector doesn't false-trigger
      lastKnownPos = pos;

      if (snap.state === 2) {
        // PAUSED: use cueVideoById so it doesn't try to auto-play,
        // then seek to the correct position
        player.cueVideoById({ videoId: video.videoId, startSeconds: pos });
      } else {
        // PLAYING or other state: loadVideoById starts playback
        player.loadVideoById({ videoId: video.videoId, startSeconds: pos });
      }
    }
  } else {
    resetPlayer();
  }
}

function syncPlay(position) {
  if (!playerReady) return;
  enterSyncGuard();
  if (position != null) {
    const diff = Math.abs(player.getCurrentTime() - position);
    if (diff > SEEK_THRESHOLD_S) player.seekTo(position, true);
    lastKnownPos = position;
  }
  player.playVideo();
}

function syncPause(position) {
  if (!playerReady) return;
  enterSyncGuard();
  player.pauseVideo();
  if (position != null) {
    const diff = Math.abs(player.getCurrentTime() - position);
    if (diff > SEEK_THRESHOLD_S) player.seekTo(position, true);
    lastKnownPos = position;
  }
}

function syncSeek(position) {
  if (!playerReady || position == null) return;
  enterSyncGuard();
  player.seekTo(position, true);
  lastKnownPos = position;
}

// ── Queue Management ──────────────────────────────
function addToQueue(video, broadcast = true) {
  queue.push(video);
  renderQueue();

  if (broadcast) {
    sendWS({ type: 'yt_queue_add', video });

    // Auto-load first video only if we are the ones adding it
    if (queue.length === 1) {
      loadQueueItem(0, true);
    }

    sendSnapshotToServer();
  } else {
    // Remote add: if this is the first video and nothing is playing yet,
    // don't auto-load — wait for the yt_load_video message from the sender.
    // But DO update the queue count/UI.
  }
}

function removeFromQueue(index, broadcast = true) {
  if (index < 0 || index >= queue.length) return;
  queue.splice(index, 1);

  // Adjust current index
  if (index < currentIdx) {
    currentIdx--;
  } else if (index === currentIdx) {
    currentIdx = Math.min(currentIdx, queue.length - 1);
    if (queue.length > 0) loadQueueItem(currentIdx, false);
    else resetPlayer();
  }

  renderQueue();

  if (broadcast) {
    sendWS({ type: 'yt_queue_remove', index });
    sendSnapshotToServer();
  }
}

function loadQueueItem(index, broadcast = true, position = 0) {
  if (index < 0 || index >= queue.length) return;
  currentIdx = index;
  const video = queue[index];

  // Always hide the empty placeholder when we have a video to load
  playerEmpty.style.display = 'none';

  enterSyncGuard();
  if (playerReady) {
    player.loadVideoById({ videoId: video.videoId, startSeconds: position });
    // Update lastKnownPos so seek detector doesn't false-trigger
    lastKnownPos = position;
  } else {
    // Defer the actual video load until player is ready
    pendingLoad = { index, position };
  }

  nowPlayingLbl.innerHTML = `
    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>
    ${escapeHtml(video.title)}
  `;

  updateNavButtons();
  renderQueue();

  if (broadcast) {
    // Include the video data in the message so the remote peer can add it
    // to their queue if it hasn't arrived yet (fixes yt_queue_add race)
    sendWS({ type: 'yt_load_video', index: index, position: position, video: video });
    // Track video watch event
    if (window.snuggleTrack) snuggleTrack('yt_watch', { videoId: video.videoId, title: video.title, roomCode: ROOM_CODE });
  }

  // Ensure the server knows about the current playing video
  sendSnapshotToServer();
}

function playNext(broadcast = true) {
  if (currentIdx < queue.length - 1) {
    loadQueueItem(currentIdx + 1, false);
    if (broadcast) sendWS({ type: 'yt_next' });
  }
}

function playPrev(broadcast = true) {
  if (currentIdx > 0) {
    loadQueueItem(currentIdx - 1, false);
    if (broadcast) sendWS({ type: 'yt_prev' });
  }
}

function resetPlayer() {
  currentIdx = -1;
  if (playerReady) player.stopVideo();
  playerEmpty.style.display = 'flex';
  nowPlayingLbl.innerHTML = `
    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>
    Nothing playing
  `;
  updateNavButtons();
}

function renderQueue() {
  queueList.innerHTML = '';

  if (queue.length === 0) {
    queueCount.textContent = '0 videos';
    // Hide the now playing bar if nothing is in the queue
    if (nowPlayingBar) nowPlayingBar.style.display = 'none';
    return;
  }

  // Show the now playing bar when queue is not empty
  if (nowPlayingBar) nowPlayingBar.style.display = '';
  queueCount.textContent = `${queue.length} video${queue.length !== 1 ? 's' : ''}`;

  queue.forEach((video, i) => {
    const li = document.createElement('li');
    li.className = 'yt-queue-item' + (i === currentIdx ? ' yt-queue-item--active' : '');
    li.setAttribute('role', 'listitem');
    li.innerHTML = `
      <span class="yt-queue-num">${i + 1}</span>
      <img class="yt-queue-thumb" src="${video.thumbnail}" alt="" loading="lazy" width="80" height="45">
      <span class="yt-queue-title">${escapeHtml(video.title)}</span>
      <button type="button" class="yt-queue-remove" aria-label="Remove ${escapeHtml(video.title)} from queue" data-index="${i}">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    `;

    // Click on item to play it
    li.addEventListener('click', (e) => {
      if (!e.target.closest('.yt-queue-remove')) {
        loadQueueItem(i, true);
      }
    });

    // Remove button
    li.querySelector('.yt-queue-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      removeFromQueue(i);
    });

    queueList.appendChild(li);
  });

  updateNavButtons();
}

function updateNavButtons() {
  prevBtn.disabled = currentIdx <= 0;
  nextBtn.disabled = currentIdx >= queue.length - 1 || queue.length === 0;
}

// ── Search & YouTube API ──────────────────────────
function getApiKey() {
  return localStorage.getItem(API_KEY_STORE) || DEFAULT_API_KEY;
}

function updateApiKeyUI() {
  // Always has a key (default is hardcoded), so search is always enabled
  searchInput.disabled = false;
  searchInput.placeholder = 'Search YouTube…';
}

searchInput.addEventListener('input', () => {
  const val = searchInput.value.trim();
  searchClear.hidden = !val;
  clearTimeout(searchTimer);
  if (val.length < 4) {
    clearResults();
    return;
  }
  searchTimer = setTimeout(() => doSearch(val), 500);
});

let currentScrapedIds = [];
let currentSearchPage = 0;

let isUsingFallback = false;

loadMoreBtn.addEventListener('click', () => {
  if (isUsingFallback) {
    if (nextSearchPageToken && currentSearchQuery) {
      doFallbackSearch(currentSearchQuery, nextSearchPageToken);
    }
  } else if (currentScrapedIds.length > 0) {
    currentSearchPage++;
    doMetadataFetch();
  }
});

searchClear.addEventListener('click', () => {
  searchInput.value = '';
  searchClear.hidden = true;
  clearResults();
  searchInput.focus();
});

async function doSearch(query) {
  const key = getApiKey();
  if (!key) return;

  currentSearchQuery = query;
  currentSearchPage = 0;
  currentScrapedIds = [];
  isUsingFallback = false;
  nextSearchPageToken = null;
  
  showResultsLoading(true, true);
  loadMoreBtn.style.display = 'none';

  try {
    const searchRes = await fetch('/api/yt-search?q=' + encodeURIComponent(query) + '&limit=20');
    if (!searchRes.ok) throw new Error('Scraping failed');
    const searchData = await searchRes.json();
    currentScrapedIds = searchData.ids || [];
    
    if (currentScrapedIds.length === 0) {
      throw new Error('Scraping returned 0 results');
    }
    
    await doMetadataFetch();
  } catch (err) {
    console.warn('Scraping search failed, falling back to YouTube API:', err.message);
    isUsingFallback = true;
    await doFallbackSearch(query, '');
  }
}

async function doFallbackSearch(query, pageToken = '') {
  const key = getApiKey();
  
  if (pageToken) {
    loadMoreBtn.disabled = true;
    loadMoreBtn.innerHTML = '<span class="yt-spinner" style="width: 16px; height: 16px; border-width: 2px;"></span>';
  }

  try {
    const url = new URL(YT_SEARCH_URL);
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('type', 'video');
    url.searchParams.set('maxResults', '12');
    url.searchParams.set('videoEmbeddable', 'true');
    url.searchParams.set('q', query);
    url.searchParams.set('key', key);
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res  = await fetch(url.toString());
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error?.message || 'YouTube API error');
    }

    nextSearchPageToken = data.nextPageToken || null;
    renderResults(data.items || [], !!pageToken, !!nextSearchPageToken);
  } catch (err) {
    console.error('Fallback search error:', err);
    if (!pageToken) {
      resultsGrid.innerHTML = '';
      resultsEmpty.textContent = 'Error fetching results.';
      resultsEmpty.hidden = false;
    }
  } finally {
    if (!pageToken) {
      showResultsLoading(false);
    } else {
      loadMoreBtn.disabled = false;
      loadMoreBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      `;
    }
  }
}

async function doMetadataFetch() {
  const key = getApiKey();
  const startIdx = currentSearchPage * 10;
  const chunkIds = currentScrapedIds.slice(startIdx, startIdx + 10);
  
  if (chunkIds.length === 0) return;
  
  if (currentSearchPage > 0) {
    loadMoreBtn.disabled = true;
    loadMoreBtn.innerHTML = '<span class="yt-spinner" style="width: 16px; height: 16px; border-width: 2px;"></span>';
  }

  try {
    const url = new URL(YT_VIDEO_URL);
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('id', chunkIds.join(','));
    url.searchParams.set('key', key);

    const res = await fetch(url.toString());
    const data = await res.json();

    if (!res.ok) throw new Error(data.error?.message || 'YouTube API error');

    // Ensure they stay in the scraped order
    const itemsMap = {};
    (data.items || []).forEach(item => itemsMap[item.id] = item);
    const orderedItems = chunkIds.map(id => itemsMap[id]).filter(Boolean);

    // If there are more items to load beyond this chunk, show load more
    const hasMore = (startIdx + 10) < currentScrapedIds.length;
    
    // Hack: renderResults will use 'append' if currentSearchPage > 0
    // Wait, nextSearchPageToken is checked inside renderResults, we'll patch that in next call
    renderResults(orderedItems, currentSearchPage > 0, hasMore);
  } catch (err) {
    console.error('Metadata error:', err);
  } finally {
    if (currentSearchPage === 0) {
      showResultsLoading(false);
    } else {
      loadMoreBtn.disabled = false;
      loadMoreBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      `;
    }
  }
}

function renderResults(items, append = false, hasMore = false) {
  if (!append) {
    resultsGrid.innerHTML = '';
  }

  if (items.length === 0 && !append) {
    resultsEmpty.hidden = false;
    resultsEmpty.textContent = 'No results found. Try a different search.';
    loadMoreBtn.style.display = 'none';
    return;
  }

  resultsEmpty.hidden = true;

  items.forEach(item => {
    // Search returns item.id.videoId, Videos endpoint returns item.id as string
    const videoId   = typeof item.id === 'string' ? item.id : item.id?.videoId;
    const title     = item.snippet?.title || 'Untitled';
    const thumbnail = item.snippet?.thumbnails?.medium?.url
                    || item.snippet?.thumbnails?.default?.url
                    || '';
    const channel   = item.snippet?.channelTitle || '';

    if (!videoId) return;

    const card = document.createElement('div');
    card.className = 'yt-result-card';
    card.setAttribute('role', 'listitem');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', `Add ${title} to queue`);
    card.innerHTML = `
      <div class="yt-result-thumb-wrap">
        <img class="yt-result-thumb" src="${thumbnail}" alt="" loading="lazy">
        <div class="yt-result-add-overlay" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
        </div>
      </div>
      <p class="yt-result-title">${escapeHtml(title)}</p>
      <p class="yt-result-channel">${escapeHtml(channel)}</p>
    `;

    const addFn = () => {
      addToQueue({ videoId, title, thumbnail });
      card.classList.add('yt-result-card--added');
      setTimeout(() => card.classList.remove('yt-result-card--added'), 800);
    };

    card.addEventListener('click', addFn);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); addFn(); }
    });

    resultsGrid.appendChild(card);
  });

  loadMoreBtn.style.display = hasMore ? 'flex' : 'none';
}

function clearResults() {
  resultsGrid.innerHTML = '';
  resultsEmpty.hidden   = true;
}

function showResultsLoading(show) {
  resultsLoading.style.display = show ? 'flex' : 'none';
  if (show) resultsGrid.innerHTML = '';
}

// ── URL Paste ─────────────────────────────────────
urlInput.addEventListener('paste', (e) => {
  // Small delay to let paste complete
  setTimeout(() => tryAddUrl(), 50);
});

urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') tryAddUrl();
});

urlAddBtn.addEventListener('click', tryAddUrl);

async function tryAddUrl() {
  const raw = urlInput.value.trim();
  if (!raw) return;

  const videoId = extractYouTubeId(raw);
  if (!videoId) {
    urlInput.classList.add('yt-input--error');
    setTimeout(() => urlInput.classList.remove('yt-input--error'), 1200);
    return;
  }

  // Fetch title if API key available, else use video ID as title
  const key = getApiKey();
  let title     = videoId;
  let thumbnail = `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;

  if (key) {
    try {
      const url = new URL(YT_VIDEO_URL);
      url.searchParams.set('part', 'snippet');
      url.searchParams.set('id', videoId);
      url.searchParams.set('key', key);
      const res  = await fetch(url.toString());
      const data = await res.json();
      const item = data.items?.[0];
      if (item) {
        title     = item.snippet?.title || videoId;
        thumbnail = item.snippet?.thumbnails?.medium?.url || thumbnail;
      }
    } catch { /* use defaults */ }
  }

  addToQueue({ videoId, title, thumbnail });
  urlInput.value = '';
}

function extractYouTubeId(input) {
  // Normalize: trim whitespace and remove tracking params for cleaner matching
  input = input.trim();

  // Handles:
  // - youtu.be/ID and youtu.be/ID?si=...
  // - youtube.com/watch?v=ID and with extra params
  // - youtube.com/embed/ID
  // - youtube.com/shorts/ID and youtube.com/shorts/ID?feature=share
  // - youtube.com/live/ID
  // - youtube.com/v/ID
  // - m.youtube.com variants
  // - raw 11-char video ID
  const patterns = [
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/watch\?.*v=([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/live\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/v\/([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const pattern of patterns) {
    const m = input.match(pattern);
    if (m) return m[1];
  }
  return null;
}

// ── Status Bar ────────────────────────────────────
function setStatus(state) {
  statusDot.className   = 'yt-status-dot';
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

// ── Room Code Copy ────────────────────────────────
roomCodePill.addEventListener('click', async () => {
  const url = window.location.href;
  if (navigator.share) {
    try { await navigator.share({ title: 'Join my room', url }); return; } catch(e) {}
  }
  navigator.clipboard.writeText(url).then(() => {
    codeCopied.classList.add('visible');
    setTimeout(() => codeCopied.classList.remove('visible'), 2000);
  });
});

// ── Toast ─────────────────────────────────────────
let toastTimer = null;
function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('yt-toast--visible');
  toastTimer = setTimeout(() => toast.classList.remove('yt-toast--visible'), 3500);
}

// ── API Key Sheet (in room) ───────────────────────
roomApikeyCancel.addEventListener('click', closeRoomApikeySheet);
roomApikeyBack.addEventListener('click', closeRoomApikeySheet);

roomApikeySave.addEventListener('click', () => {
  const key = roomApikeyInput.value.trim();
  if (key) localStorage.setItem(API_KEY_STORE, key);
  closeRoomApikeySheet();
  updateApiKeyUI();
});

function closeRoomApikeySheet() {
  roomApikeySheet.classList.remove('active');
  roomApikeySheet.setAttribute('aria-hidden', 'true');
}

// ── Event Listeners ───────────────────────────────
function setupEventListeners() {
  prevBtn.addEventListener('click', () => playPrev());
  nextBtn.addEventListener('click', () => playNext());
}

// ── Utility ───────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
