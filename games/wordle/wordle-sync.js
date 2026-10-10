'use strict';

/*
 * wordle-sync.js — two-player, keystroke-synced Wordle.
 *
 * Server protocol this client expects (unchanged from your original):
 *   client -> server : {type:'create_room'} | {type:'join_room', code} | {type:'game_sync', ...}
 *   server -> client : {type:'room_created'|'room_joined', code, usersCount?}
 *                      {type:'user_joined'|'user_left', usersCount}
 *                      {type:'game_sync', ...}   <- relayed from the other player(s)
 *
 * Extra fields this version adds to 'game_sync' (the server should relay the whole message as-is):
 *   key      : 'a'..'z' | 'Enter' | 'Backspace'   one keystroke
 *   history  : [keys...]                           full keystroke log, sent when someone joins/reconnects
 *   from     : clientId                            lets a client ignore its own echo
 */
(() => {
  // ───────────────────────── config ─────────────────────────
  let SOLUTION = 'SNUGG';
  let DAILY_SOLUTION = 'SNUGG';
  let CURRENT_MODE = 'daily'; // 'daily' or 'random'

  async function fetchTodaysSolution() {
    try {
      const res = await fetch('/api/wordle-daily');
      if (res.ok) {
        const data = await res.json();
        if (data.solution) {
          DAILY_SOLUTION = data.solution.toUpperCase();
          if (CURRENT_MODE === 'daily') SOLUTION = DAILY_SOLUTION;
          console.log('[wordle-sync] Loaded daily solution.');
        }
      }
    } catch (e) {
      console.warn('[wordle-sync] Failed to fetch daily solution, using fallback.', e);
    }
  }
  const initPromise = fetchTodaysSolution();

  const WORD_LENGTH = 5;
  const MAX_GUESSES = 6;
  const RECONNECT_DELAY_MS = 3000;
  const FLIP_MS = 250;      // one half of a tile flip
  const STAGGER_MS = 300;   // delay between tiles in a row
  const WIN_MESSAGES = ['Genius', 'Magnificent', 'Impressive', 'Splendid', 'Great', 'Phew'];
  const ORDINALS = ['1st', '2nd', '3rd', '4th', '5th'];
  const RANK = { absent: 1, present: 2, correct: 3 };
  const CLIENT_ID = (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);

  document.title = 'Snuggle-Wordle';
  document.body.classList.add('loaded');

  // ───────────────────────── status bar / ribbon / toast UI ─────────────────────────
  const statusBarHtml = `
    <style>
      :root { --yt-bar-h: 52px; --yt-ribbon-h: 44px; --yt-total-h: calc(var(--yt-bar-h) + var(--yt-ribbon-h)); --vh: 100vh; }
      /* keep the fixed bars from covering the game and adjust game container to fit screen */
      body { padding-top: var(--yt-total-h) !important; box-sizing: border-box; height: var(--vh) !important; margin: 0; overflow: hidden; }
      .App-module_app__yRiXC, .App-module_gameContainer__K_CBh {
        min-height: calc(var(--vh) - var(--yt-total-h)) !important;
        height: calc(var(--vh) - var(--yt-total-h)) !important;
      }
      /* Fix layout to prevent scrolling by forcing game area to fit the viewport */
      .App-module_game__yruqo {
        max-height: 100% !important;
        height: 100% !important;
      }
      .Board-module_boardContainer__TBHNL {
        flex-grow: 1 !important;
        min-height: 0 !important;
      }
      .Board-module_board__jeoPS {
        /* Ensure the board scales down to fit available height minus keyboard (200px) and margins */
        max-width: min(350px, calc((var(--vh) - var(--yt-total-h) - 220px) * 5 / 6)) !important;
        max-height: 100% !important;
      }
      #ad-top, .Ad-module_adContainer__ZAFEc { display: none !important; }
      #yt-status-bar {
        position: fixed; top: 0; left: 0; right: 0; height: var(--yt-bar-h); z-index: 9999;
        background: #3c280d; border-bottom: 1px solid rgba(244, 162, 97, 0.2);
        display: flex; justify-content: space-between; align-items: center;
        padding: 0 16px; color: #fff; box-sizing: border-box;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      }
      /* ── ribbon ── */
      #yt-ribbon {
        position: fixed; top: var(--yt-bar-h); left: 0; right: 0; height: var(--yt-ribbon-h);
        z-index: 9998; background: #3c280d; border-bottom: 1px solid rgba(255,255,255,0.08);
        display: flex; justify-content: space-between; align-items: center;
        padding: 0 12px; box-sizing: border-box;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      }
      #yt-back-btn {
        display: flex; align-items: center; gap: 5px;
        background: none; border: 1px solid rgba(255,255,255,0.18); color: #ccc;
        padding: 5px 10px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500;
        transition: background 0.18s, color 0.18s;
      }
      #yt-back-btn:hover { background: rgba(255,255,255,0.08); color: #fff; }
      /* pill toggle */
      #yt-mode-toggle {
        display: flex; align-items: center;
        background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12);
        border-radius: 20px; padding: 3px; gap: 2px;
      }
      .yt-mode-pill {
        padding: 4px 16px; border-radius: 16px; border: none; background: none;
        color: rgba(255,255,255,0.55); font-size: 13px; font-weight: 600; cursor: pointer;
        transition: background 0.2s, color 0.2s;
      }
      .yt-mode-pill.active { background: #f4a261; color: #3c280d; }
      #yt-hint-btn {
        display: flex; align-items: center; gap: 5px;
        background: none; border: 1px solid rgba(255,255,255,0.18); color: #ccc;
        padding: 5px 12px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500;
        transition: background 0.18s, color 0.18s;
      }
      #yt-hint-btn:hover { background: rgba(255,255,255,0.08); color: #fff; }
      /* toast sits below both bars */
      .yt-toast {
        position: fixed; top: calc(var(--yt-total-h) + 12px); left: 50%; transform: translateX(-50%);
        z-index: 10000; background: #fff; color: #3c280d; padding: 10px 16px; border-radius: 4px;
        font: 700 14px/1.2 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
        opacity: 0; pointer-events: none; transition: opacity 0.2s; white-space: nowrap;
      }
      .yt-toast.show { opacity: 1; }
      /* confirm dialog */
      #yt-confirm-overlay {
        display: none; position: fixed; inset: 0; z-index: 11000;
        background: rgba(0,0,0,0.6); align-items: center; justify-content: center;
      }
      #yt-confirm-overlay.show { display: flex; }
      #yt-confirm-box {
        background: #876a4b; border: 1px solid rgba(244,162,97,0.4); border-radius: 12px;
        padding: 28px 32px; max-width: 340px; width: 90%; text-align: center;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
        color: #fff;
      }
      #yt-confirm-box p { margin: 0 0 20px; font-size: 15px; line-height: 1.5; }
      #yt-confirm-box .yt-btn-row { display: flex; gap: 10px; justify-content: center; }
      #yt-confirm-box button {
        flex: 1; padding: 8px 0; border-radius: 7px; border: none; font-size: 14px;
        font-weight: 600; cursor: pointer;
      }
      #yt-confirm-cancel { background: rgba(255,255,255,0.1); color: #ccc; }
      #yt-confirm-ok { background: #f4a261; color: #3c280d; }
      /* ── hint popup ── */
      #yt-hint-overlay {
        display: none; position: fixed; inset: 0; z-index: 11000;
        background: rgba(0,0,0,0.55); align-items: flex-start; justify-content: center;
        padding-top: calc(var(--yt-total-h) + 16px);
      }
      #yt-hint-overlay.show { display: flex; }
      #yt-hint-popup {
        background: #876a4b; border: 1px solid rgba(244,162,97,0.4); border-radius: 12px;
        width: min(420px, 92vw); max-height: min(520px, 70vh);
        display: flex; flex-direction: column; overflow: hidden;
        font-family: "nyt-franklin", "Clear Sans", "Helvetica Neue", Arial, sans-serif !important;
        box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      }
      #yt-hint-popup * {
        font-family: "nyt-franklin", "Clear Sans", "Helvetica Neue", Arial, sans-serif !important;
      }
      #yt-hint-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 14px 16px 12px; border-bottom: 1px solid rgba(255,255,255,0.08);
        flex-shrink: 0;
      }
      #yt-hint-title {
        font-size: 14px; font-weight: 700; color: #f4a261; letter-spacing: 0.5px;
        text-transform: uppercase;
      }
      #yt-hint-count {
        font-size: 12px; font-weight: 500; color: rgba(255,255,255,0.45);
        margin-left: 8px;
      }
      #yt-hint-close {
        background: none; border: none; color: rgba(255,255,255,0.45); cursor: pointer;
        font-size: 18px; line-height: 1; padding: 2px 4px; border-radius: 4px;
        transition: color 0.15s, background 0.15s;
      }
      #yt-hint-close:hover { color: #fff; background: rgba(255,255,255,0.08); }
      #yt-hint-body {
        overflow-y: auto; padding: 8px 0; flex: 1;
        scrollbar-width: thin; scrollbar-color: rgba(244,162,97,0.3) transparent;
      }
      #yt-hint-body::-webkit-scrollbar { width: 4px; }
      #yt-hint-body::-webkit-scrollbar-thumb { background: rgba(244,162,97,0.35); border-radius: 2px; }
      .yt-hint-word {
        padding: 7px 16px; font-size: 14px; font-weight: bold; letter-spacing: 2px;
        color: #e0e0e0; text-transform: uppercase; cursor: default;
        transition: background 0.1s;
      }
      .yt-hint-word:hover { background: rgba(255,255,255,0.05); }
      .yt-hint-empty {
        padding: 20px 16px; font-size: 13px; color: rgba(255,255,255,0.4);
        text-align: center; font-style: italic;
      }

    </style>

    <!-- confirm dialog (reused for back + mode switch) -->
    <div id="yt-confirm-overlay" role="dialog" aria-modal="true" aria-labelledby="yt-confirm-msg">
      <div id="yt-confirm-box">
        <p id="yt-confirm-msg"></p>
        <div class="yt-btn-row">
          <button id="yt-confirm-cancel">Cancel</button>
          <button id="yt-confirm-ok">Continue</button>
        </div>
      </div>
    </div>

    <!-- hint popup (local-only, not synced) -->
    <div id="yt-hint-overlay" role="dialog" aria-modal="true" aria-labelledby="yt-hint-title">
      <div id="yt-hint-popup">
        <div id="yt-hint-header">
          <div style="display:flex; align-items:baseline; gap:0;">
            <span id="yt-hint-title">Possible Words</span>
            <span id="yt-hint-count"></span>
          </div>
          <button id="yt-hint-close" aria-label="Close hint" title="Close">&#x2715;</button>
        </div>
        <div id="yt-hint-body"></div>
      </div>
    </div>

    <div class="yt-toast" id="yt-toast" role="status" aria-live="polite" aria-atomic="true"></div>

    <div id="yt-status-bar">
      <div style="display:flex; gap:8px; align-items:center;">
        <span id="status-dot" style="width:10px; height:10px; border-radius:50%; background:#f39c12; display:inline-block;"></span>
        <span id="status-label" style="font-size:14px; font-weight:500;">Connecting...</span>
      </div>
      <button type="button" id="copy-btn" aria-label="Copy invite link" title="Tap to copy invite link"
        style="background:rgba(255,255,255,0.1); border:1px solid rgba(255,255,255,0.2); color:#fff; padding:6px 12px; border-radius:6px; cursor:pointer; display:flex; align-items:center; gap:6px; font-size:14px; font-weight:600; transition:background 0.2s;">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
          
          
        </svg>
        <span id="room-code-display" style="letter-spacing:1px;">------</span>
        <span id="yt-code-copied" style="display:none; color:#4ade80;">Copied!</span>
      </button>
    </div>

    <div id="yt-ribbon">
      <!-- Back button -->
      <button type="button" id="yt-back-btn" aria-label="Back to games">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="15 18 9 12 15 6"/>
        </svg>
        Back
      </button>

      <!-- Daily / Random pill toggle -->
      <div id="yt-mode-toggle" role="group" aria-label="Game mode">
        <button type="button" class="yt-mode-pill active" id="yt-pill-daily" data-mode="daily">Daily</button>
        <button type="button" class="yt-mode-pill" id="yt-pill-random" data-mode="random">Random</button>
      </div>

      <!-- Hint button (functionality to be added later) -->
      <button type="button" id="yt-hint-btn" aria-label="Get a hint">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="16" x2="12" y2="12"/>
          <line x1="12" y1="8" x2="12.01" y2="8"/>
        </svg>
        Hint
      </button>
    </div>
  `;
  document.body.insertAdjacentHTML('afterbegin', statusBarHtml);

  // Maintain precise viewport height for mobile browsers
  function updateViewportHeight() {
    document.documentElement.style.setProperty('--vh', `${window.innerHeight}px`);
  }
  window.addEventListener('resize', updateViewportHeight);
  window.addEventListener('orientationchange', updateViewportHeight);
  updateViewportHeight();

  const statusDot = document.getElementById('status-dot');
  const statusLabel = document.getElementById('status-label');
  const roomCodeDisplay = document.getElementById('room-code-display');
  const copyBtn = document.getElementById('copy-btn');
  const copiedSpan = document.getElementById('yt-code-copied');
  const toastEl = document.getElementById('yt-toast');

  // ── ribbon element refs ──
  const backBtn       = document.getElementById('yt-back-btn');
  const pillDaily     = document.getElementById('yt-pill-daily');
  const pillRandom    = document.getElementById('yt-pill-random');
  const hintBtn        = document.getElementById('yt-hint-btn');
  const hintOverlay    = document.getElementById('yt-hint-overlay');
  const hintBody       = document.getElementById('yt-hint-body');
  const hintCountEl    = document.getElementById('yt-hint-count');
  const hintCloseBtn   = document.getElementById('yt-hint-close');

  const confirmOverlay = document.getElementById('yt-confirm-overlay');
  const confirmMsg     = document.getElementById('yt-confirm-msg');
  const confirmOk      = document.getElementById('yt-confirm-ok');
  const confirmCancel  = document.getElementById('yt-confirm-cancel');

  // Show a modal confirm dialog; resolves true (ok) or false (cancel).
  function showConfirm(message) {
    return new Promise(resolve => {
      confirmMsg.textContent = message;
      confirmOverlay.classList.add('show');
      const cleanup = (result) => {
        confirmOverlay.classList.remove('show');
        confirmOk.removeEventListener('click', okHandler);
        confirmCancel.removeEventListener('click', cancelHandler);
        resolve(result);
      };
      const okHandler     = () => cleanup(true);
      const cancelHandler = () => cleanup(false);
      confirmOk.addEventListener('click', okHandler);
      confirmCancel.addEventListener('click', cancelHandler);
    });
  }

  // ── board reset ──
  function resetBoard() {
    currentRow = 0;
    currentCol = 0;
    gameOver   = false;
    keyLog.length = 0;
    board.forEach(row => {
      row.forEach(tile => {
        tile.textContent = '';
        tile.setAttribute('data-state', 'empty');
        tile.removeAttribute('data-animation');
        tile.setAttribute('aria-label', 'empty');
      });
    });
    // Reset key colours
    document.querySelectorAll('button[data-key]').forEach(btn => {
      btn.removeAttribute('data-state');
    });
    refreshKeyboard();
  }

  // ── random word helper ──
  function pickRandomWord() {
    if (typeof VALID_WORDS === 'undefined') return null;
    const arr = [...VALID_WORDS];
    // Only keep 5-letter words (sanity check; the set should already be 5-letter)
    const words = arr.filter(w => w.length === 5);
    return words[Math.floor(Math.random() * words.length)].toUpperCase();
  }

  // ── update pill UI ──
  function updatePillUI(mode) {
    pillDaily.classList.toggle('active', mode === 'daily');
    pillRandom.classList.toggle('active', mode === 'random');
  }

  // Returns true if the game is "at rest" (no moves, game won, or game lost).
  function gameIsAtRest() {
    // No moves played yet
    if (currentRow === 0 && currentCol === 0) return true;
    // Game finished (won or lost — gameOver flag is set)
    if (gameOver) return true;
    return false;
  }

  // Apply a new mode + optional pre-chosen solution (for remote-driven switches).
  // When solution is omitted we generate/fetch it ourselves (local user initiated).
  function applyMode(mode, solution) {
    CURRENT_MODE = mode;
    if (solution) {
      SOLUTION = solution.toUpperCase();
    } else if (mode === 'daily') {
      SOLUTION = DAILY_SOLUTION;
    } else {
      const word = pickRandomWord();
      if (word) SOLUTION = word;
    }
    updatePillUI(mode);
    resetBoard();
    showToast(mode === 'daily' ? '📅 Switched to Daily' : '🎲 Switched to Random');
  }

  // ── mode pill click handler ──
  async function onModePillClick(requestedMode) {
    if (requestedMode === CURRENT_MODE) return;  // already on this mode

    if (!gameIsAtRest()) {
      const label = requestedMode === 'daily' ? 'Daily' : 'Random';
      const ok = await showConfirm(
        `Switch to ${label} mode? Your current game will be reset.`
      );
      if (!ok) return;
    }

    // Pick the solution before broadcasting so both clients get the same word
    let newSolution;
    if (requestedMode === 'daily') {
      newSolution = DAILY_SOLUTION;
    } else {
      newSolution = pickRandomWord() || DAILY_SOLUTION;
    }

    applyMode(requestedMode, newSolution);
    // Broadcast to partner(s)
    send({ type: 'game_sync', mode_change: requestedMode, solution: newSolution });
  }

  pillDaily.addEventListener('click',  () => onModePillClick('daily'));
  pillRandom.addEventListener('click', () => onModePillClick('random'));

  // ── back button ──
  backBtn.addEventListener('click', async () => {
    if (!gameIsAtRest()) {
      const ok = await showConfirm('Leave this game? Your progress will be lost.');
      if (!ok) return;
    }
    // Navigate back to the games hub
    window.location.href = '/games/';
  });

  // ── hint popup ──────────────────────────────────────────────────────────────

  /**
   * Read the already-revealed rows and extract constraints:
   *   correct[i]  = letter that MUST be at position i (green)
   *   present     = Map<letter, Set<positions where it must NOT be>> (yellow)
   *   absent      = Set<letter> that must not appear at all
   *
   * Grey (absent) letters are only truly absent when they weren't also marked
   * correct/present in the same or a different guess (handles duplicate-letter edge cases).
   */
  function readBoardConstraints() {
    const correct  = new Array(WORD_LENGTH).fill(null);   // index → letter | null
    const present  = new Map();                           // letter → Set of forbidden positions
    const absent   = new Set();

    for (let r = 0; r < currentRow; r++) {
      const row = board[r];
      // Collect which letters are confirmed in this row first
      const rowConfirmed = new Set();
      row.forEach((tile, i) => {
        const state = tile.getAttribute('data-state');
        const letter = tile.textContent.trim().toLowerCase();
        if (!letter) return;
        if (state === 'correct') { correct[i] = letter; rowConfirmed.add(letter); }
        if (state === 'present') { rowConfirmed.add(letter); }
      });
      // Now process absent tiles — only truly absent if letter not confirmed anywhere
      row.forEach((tile, i) => {
        const state = tile.getAttribute('data-state');
        const letter = tile.textContent.trim().toLowerCase();
        if (!letter) return;
        if (state === 'correct') {
          correct[i] = letter;
          if (!present.has(letter)) present.set(letter, new Set());
        } else if (state === 'present') {
          if (!present.has(letter)) present.set(letter, new Set());
          present.get(letter).add(i);
        } else if (state === 'absent') {
          // Only mark absent if this letter wasn't green/yellow in this same row
          if (!rowConfirmed.has(letter)) absent.add(letter);
        }
      });
    }

    return { correct, present, absent };
  }

  /**
   * Given board constraints, return the alphabetically-sorted list of
   * words from VALID_WORDS that are still consistent with everything we know.
   */
  function getPossibleWords() {
    if (typeof VALID_WORDS === 'undefined') return [];
    const { correct, present, absent } = readBoardConstraints();

    return [...VALID_WORDS]
      .filter(word => {
        if (word.length !== WORD_LENGTH) return false;
        const w = word.toLowerCase();

        // 1. Green positions must match
        for (let i = 0; i < WORD_LENGTH; i++) {
          if (correct[i] && w[i] !== correct[i]) return false;
        }
        // 2. Yellow letters must be present, but not in their forbidden positions
        for (const [letter, forbiddenPositions] of present) {
          if (!w.includes(letter)) return false;
          for (const pos of forbiddenPositions) {
            if (w[pos] === letter) return false;
          }
        }
        // 3. Absent letters must not appear
        for (const letter of absent) {
          // Exception: if a letter is also confirmed as correct/present, it can still appear
          if (present.has(letter) || correct.includes(letter)) continue;
          if (w.includes(letter)) return false;
        }
        return true;
      })
      .sort();
  }

  function openHintPopup() {
    const words = getPossibleWords();
    const n = words.length;

    // Update count label
    hintCountEl.textContent = `\u00a0— ${n} word${n !== 1 ? 's' : ''}`;

    // Render word list
    if (n === 0) {
      hintBody.innerHTML = '<div class="yt-hint-empty">No possible words found.</div>';
    } else {
      hintBody.innerHTML = words
        .map(w => `<div class="yt-hint-word">${w.toUpperCase()}</div>`)
        .join('');
    }

    hintOverlay.classList.add('show');
    hintCloseBtn.focus();
  }

  function closeHintPopup() {
    hintOverlay.classList.remove('show');
    hintBtn.focus();
  }

  hintBtn.addEventListener('click', openHintPopup);
  hintCloseBtn.addEventListener('click', closeHintPopup);

  hintBody.addEventListener('click', (e) => {
    if (e.target.classList.contains('yt-hint-word')) {
      const word = e.target.textContent;
      closeHintPopup();
      while (currentCol > 0) {
        localKey('Backspace');
      }
      for (const char of word) {
        localKey(char);
      }
    }
  });

  // Close on backdrop click (outside the popup card)
  hintOverlay.addEventListener('click', (e) => {
    if (e.target === hintOverlay) closeHintPopup();
  });

  // Close on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && hintOverlay.classList.contains('show')) {
      closeHintPopup();
    }
  });


  const DOT = { connecting: '#f39c12', online: '#2ecc71', offline: '#e74c3c' };
  function setStatus(kind, text) {

    statusDot.style.background = DOT[kind];
    statusLabel.textContent = text;
  }
  function showPeers(count) {
    setStatus(count > 1 ? 'online' : 'connecting', count > 1 ? 'Synced with friend!' : 'Waiting');
  }
  // usersCount if the server sent one, otherwise a sensible default for that event
  function peerCount(msg, fallback) {
    return Number.isFinite(msg.usersCount) ? msg.usersCount : fallback;
  }

  let toastTimer = null;
  function showToast(text, ms = 1800) {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
  }

  // ───────────────────────── game state ─────────────────────────
  const board = [...document.querySelectorAll('.Row-module_row__pwpBq')]
    .map(row => [...row.querySelectorAll('.Tile-module_tile__UWEHN')]);
  const boardOk = board.length === MAX_GUESSES && board.every(r => r.length === WORD_LENGTH);
  if (!boardOk) console.error('[wordle-sync] Board markup not found (expected 6 rows x 5 tiles).');

  let currentRow = 0;
  let currentCol = 0;
  let gameOver = false;
  const keyLog = []; // every accepted keystroke, in order — lets late joiners / reconnecting players catch up

  function normalizeKey(k) {
    if (typeof k !== 'string') return null;
    if (k === 'Enter' || k === '↵') return 'Enter';
    if (k === 'Backspace' || k === '←') return 'Backspace';
    if (/^[a-z]$/i.test(k)) return k.toLowerCase();
    return null;
  }

  // Wordle scoring: exact matches first, then "present" only while unmatched copies remain.
  function evaluate(guess) {
    const result = new Array(WORD_LENGTH).fill('absent');
    const remaining = {};
    for (let i = 0; i < WORD_LENGTH; i++) {
      if (guess[i] === SOLUTION[i]) result[i] = 'correct';
      else remaining[SOLUTION[i]] = (remaining[SOLUTION[i]] || 0) + 1;
    }
    for (let i = 0; i < WORD_LENGTH; i++) {
      if (result[i] === 'correct') continue;
      if (remaining[guess[i]] > 0) { result[i] = 'present'; remaining[guess[i]]--; }
    }
    return result;
  }

  function paintKey(letter, state) {
    const btn = document.querySelector(`button[data-key="${letter.toLowerCase()}"]`);
    if (!btn) return;
    const current = btn.getAttribute('data-state');
    if (!current || RANK[state] > (RANK[current] || 0)) btn.setAttribute('data-state', state); // never downgrade
  }

  // Keep Enter/Backspace/letters' aria-disabled in step with the game, like the original app does.
  function refreshKeyboard() {
    document.querySelectorAll('button[data-key]').forEach(btn => {
      const k = btn.getAttribute('data-key');
      let disabled = gameOver;
      if (!gameOver && k === '↵') disabled = currentCol < WORD_LENGTH;
      if (!gameOver && k === '←') disabled = currentCol === 0;
      btn.setAttribute('aria-disabled', String(disabled));
    });
  }

  function revealRow(tiles, guess, result, instant) {
    tiles.forEach((tile, i) => {
      const paint = () => {
        tile.setAttribute('data-state', result[i]);
        tile.setAttribute('aria-label', `${ORDINALS[i]} letter, ${guess[i]}, ${result[i]}`);
      };
      if (instant) { paint(); tile.setAttribute('data-animation', 'idle'); return; }
      setTimeout(() => {
        tile.setAttribute('data-animation', 'flip-in');            // tile turns edge-on…
        setTimeout(() => {
          paint();                                                  // …colour changes while it can't be seen…
          tile.setAttribute('data-animation', 'flip-out');          // …then turns back
          setTimeout(() => tile.setAttribute('data-animation', 'idle'), FLIP_MS);
        }, FLIP_MS);
      }, i * STAGGER_MS);
    });
  }

  function submitRow(tiles, instant) {
    const rowIndex = currentRow;
    const guess = tiles.map(t => t.textContent.trim().toUpperCase()).join('');
    const result = evaluate(guess);

    currentRow++;
    currentCol = 0;
    const won = guess === SOLUTION;
    if (won || currentRow >= MAX_GUESSES) gameOver = true;

    revealRow(tiles, guess, result, instant);

    const finish = () => {
      [...guess].forEach((ch, i) => paintKey(ch, result[i]));   // keyboard colours after the row finishes flipping
      if (!instant && gameOver) showToast(won ? WIN_MESSAGES[rowIndex] : SOLUTION, 5000);
    };
    if (instant) finish();
    else setTimeout(finish, (WORD_LENGTH - 1) * STAGGER_MS + 2 * FLIP_MS);

    refreshKeyboard();
  }

  // Applies one keystroke. Returns true if it changed the game (so it should be logged / sent).
  function applyKey(key, { instant = false } = {}) {
    if (!boardOk || gameOver || currentRow >= MAX_GUESSES) return false;
    const tiles = board[currentRow];

    if (key === 'Enter') {
      if (currentCol < WORD_LENGTH) { if (!instant) showToast('Not enough letters'); return false; }
      const guess = tiles.map(t => t.textContent).join('').toLowerCase();
      if (typeof VALID_WORDS !== 'undefined' && !VALID_WORDS.has(guess)) { if (!instant) showToast('Not in word list'); return false; }
      submitRow(tiles, instant);
      return true;
    }

    if (key === 'Backspace') {
      if (currentCol === 0) return false;
      currentCol--;
      const tile = tiles[currentCol];
      tile.textContent = '';
      tile.setAttribute('data-state', 'empty');
      tile.removeAttribute('data-animation');
      tile.setAttribute('aria-label', `${ORDINALS[currentCol]} letter, empty`);
      refreshKeyboard();
      return true;
    }

    if (currentCol >= WORD_LENGTH) return false;
    const tile = tiles[currentCol];
    const letter = key.toUpperCase();
    tile.textContent = letter;
    tile.setAttribute('data-state', 'tbd');
    tile.setAttribute('data-animation', instant ? 'idle' : 'pop');
    tile.setAttribute('aria-label', `${ORDINALS[currentCol]} letter, ${letter}`);
    currentCol++;
    refreshKeyboard();
    return true;
  }

  // ───────────────────────── networking ─────────────────────────
  const urlParams = new URLSearchParams(window.location.search);
  const urlCode = urlParams.get('code');
  if (urlCode) {
    sessionStorage.setItem('snuggle_room_code', urlCode.toUpperCase().trim());
  }
  const requestedCode = sessionStorage.getItem('snuggle_room_code');
  if (!requestedCode) {
    window.location.href = '/welcome.html';
    return;
  } else if (!urlCode || urlCode.toUpperCase().trim() !== requestedCode) {
    urlParams.set('code', requestedCode);
    window.history.replaceState({}, '', `${window.location.pathname}?${urlParams.toString()}`);
  }
  let ws = null;
  let roomCode = null;
  let joining = false;
  let reconnectTimer = null;

  function rawSend(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }
  function send(obj) {          // game messages: only once we're in a room
    if (roomCode) rawSend({ ...obj, from: CLIENT_ID });
  }

  function syncUrl() {
    try {
      const u = new URL(window.location.href);
      if (u.searchParams.get('code') === roomCode) return;
      u.searchParams.delete('action');
      u.searchParams.set('code', roomCode);
      window.history.replaceState(null, '', u);
    } catch (_) { /* cosmetic only */ }
  }

  function shareHistory() {
    if (keyLog.length) send({ type: 'game_sync', history: keyLog.slice() });
  }

  // Accept a friend's full keystroke log only if it extends ours (we're new, or we missed keys while offline).
  function mergeHistory(incoming) {
    const keys = incoming.map(normalizeKey);
    if (keys.some(k => k === null) || keys.length <= keyLog.length) return;
    for (let i = 0; i < keyLog.length; i++) if (keyLog[i] !== keys[i]) return; // boards diverged — don't guess
    keys.slice(keyLog.length).forEach(k => { if (applyKey(k, { instant: true })) keyLog.push(k); });
  }

  function onGameSync(msg) {
    if (msg.from && msg.from === CLIENT_ID) return;             // our own echo
    if (Array.isArray(msg.history)) { mergeHistory(msg.history); return; }
    // ── remote mode switch ──
    if (msg.mode_change) {
      applyMode(msg.mode_change, msg.solution || null);
      return;
    }
    const key = normalizeKey(msg.key);
    if (key && applyKey(key)) keyLog.push(key);
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'room_created':
      case 'room_joined':
        joining = false;
        roomCode = msg.code || roomCode;
        localStorage.setItem('snuggle_last_room_code', roomCode);
        roomCodeDisplay.textContent = roomCode;
        syncUrl();
        showPeers(peerCount(msg, msg.type === 'room_joined' ? 2 : 1));
        if (msg.type === 'room_joined') shareHistory();          // e.g. we reconnected and have keys they missed
        if (window.snuggleTrack) snuggleTrack(msg.type === 'room_created' ? 'room_create' : 'room_join', { roomCode, section: 'wordle' });
        if (window.snuggleTrack) snuggleTrack('game_play', { game: 'wordle', action: msg.type === 'room_created' ? 'create' : 'join', roomCode });
        break;
      case 'user_joined':
        showPeers(peerCount(msg, 2));
        shareHistory();                                          // bring the newcomer up to date
        break;
      case 'user_left':
        showPeers(peerCount(msg, 1));
        break;
      case 'game_sync':
        onGameSync(msg);
        break;
      default:
        // join failed (bad/expired code): start a fresh room instead of hanging on "Joining..."
        if (joining && /error|not.?found|invalid|fail/i.test(`${msg.type} ${msg.message || ''}`)) {
          joining = false;
          roomCode = null;
          setStatus('online', 'Room not found — creating a new one...');
          rawSend({ type: 'create_room' });
        }
    }
  }

  function connect() {
    clearTimeout(reconnectTimer);

    // Opened straight from disk (file://) — there is no server to talk to; play solo instead of crashing.
    if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') {
      setStatus('offline', 'Offline (open via your server to play together)');
      return;
    }

    let socket;
    try {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${protocol}//${window.location.host}`);
    } catch (err) {
      console.error('[wordle-sync] WebSocket failed to open:', err);
      setStatus('offline', 'Offline (solo mode)');
      return;
    }
    ws = socket;

    socket.onopen = () => {
      // after a reconnect roomCode is set, so we rejoin the SAME room instead of creating a new one
      const code = roomCode || requestedCode;
      if (code) {
        joining = true;
        setStatus('online', 'Joining room...');
        rawSend({ type: 'join_room', code });
      } else {
        setStatus('online', 'Creating room...');
        rawSend({ type: 'create_room' });
      }
    };

    socket.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch (_) { return; }
      if (msg && typeof msg === 'object') handleMessage(msg);
    };

    socket.onclose = () => {
      if (ws !== socket) return;
      setStatus('offline', 'Disconnected — reconnecting...');
      reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
    };
  }

  // ───────────────────────── input ─────────────────────────
  function localKey(key) {
    if (applyKey(key)) {
      keyLog.push(key);
      send({ type: 'game_sync', key });
      // After Enter (word submitted), push a full history snapshot so the
      // server always has the latest state for refresh recovery
      if (key === 'Enter') setTimeout(shareHistory, 100);
    }
  }

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;   // don't hijack Ctrl+R, Ctrl+A, Alt+F…
    const target = e.target instanceof Element ? e.target : null;
    if (target && target.closest('input, textarea, select, [contenteditable]')) return;
    const key = normalizeKey(e.key);
    if (!key) return;
    if (key === 'Enter') {
      if (e.repeat) return;
      if (target && target.closest('button')) return;                  // Enter on a focused button = that button's click
    }
    e.preventDefault();
    localKey(key);
  });

  // Don't let on-screen keys take focus — otherwise a later physical Enter/Space re-"clicks" the last key you tapped.
  document.addEventListener('mousedown', (e) => {
    if (e.target instanceof Element && e.target.closest('button[data-key]')) e.preventDefault();
  });

  document.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('button[data-key]') : null;
    if (!btn) return;
    btn.blur();
    const key = normalizeKey(btn.getAttribute('data-key'));
    if (key) localKey(key);
  });

  // ───────────────────────── copy invite link ─────────────────────────
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (_) { /* fall through (http:// or denied) */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (_) { return false; }
  }

  let copiedTimer = null;
  copyBtn.addEventListener('click', async () => {
    copyBtn.blur();                                                    // so a later Enter submits the guess, not re-copies
    if (!roomCode) { showToast('Room not ready yet'); return; }
    const url = window.location.href;
    if (navigator.share) {
      try { await navigator.share({ title: 'Join my room', url }); return; } catch (e) {}
    }
    if (!(await copyText(url))) { showToast('Copy failed — copy the link from the address bar', 3000); return; }
    roomCodeDisplay.style.display = 'none';
    copiedSpan.style.display = 'inline';
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copiedSpan.style.display = 'none';
      roomCodeDisplay.style.display = '';
    }, 2000);
  });

  // ───────────────────────── go ─────────────────────────
  refreshKeyboard();
  initPromise.then(() => connect());
})();
