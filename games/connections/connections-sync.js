'use strict';

/*
 * Snuggle-Connections — two-player synced Connections.
 *
 * How sync works (v2):
 *   Every piece of shared state is a small "register" that converges no matter
 *   what order messages arrive in, using a Lamport clock (counter + client id):
 *     • selection  – last-writer-wins register (whole selection set)
 *     • card order – last-writer-wins register (shuffle sends the actual order)
 *     • guesses    – a grow-only set, ordered by Lamport timestamp. Solved groups,
 *                    mistakes and game-over are *derived* from it, so both players
 *                    always land on the same board.
 *   Full snapshots are exchanged on join / reconnect and every few seconds, so a
 *   dropped message or a flaky mobile connection heals itself.
 */

(() => {
  // ───────────────────────── config ─────────────────────────
  const API_URL      = '/api/connections-daily';
  const MAX_MISTAKES = 4;
  const SNAPSHOT_MS  = 5000;

  const sleep     = ms => new Promise(r => setTimeout(r, ms));
  const nextFrame = () => new Promise(r => requestAnimationFrame(() => r()));

  const CLIENT_ID = (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);

  document.title = 'Snuggle-Connections';
  document.body.classList.add('loaded');

  // ───────────────────────── inject UI + CSS ─────────────────────────
  const statusBarHtml = `
    <style>
      :root { --yt-bar-h: 52px; }

      /* ── Theme: match Snuggle dark navy ── */
      html, body { background: #3c280d !important; color: #e8e8e8 !important; height: 100vh !important; width: 100vw !important; margin: 0; display: flex; flex-direction: column; overflow-x: hidden; overflow-y: auto; }
      body { padding-top: var(--yt-bar-h) !important; box-sizing: border-box; }

      /* Override NYT CSS variables */
      :root, [data-mode="dark"] {
        --bg-page: #3c280d !important;
        --bg-games: #3c280d !important;
        --white: #3c280d !important;
        --dark-black: #3c280d !important;
        --text: #e8e8e8 !important;
        --black: #e8e8e8 !important;
        --color-tone-1: #e8e8e8 !important;
        --color-tone-7: #3c280d !important;
      }

      /* ── Force game board wrappers visible ── */
      .pz-game-field, .pz-game-screen, .pz-game-wrapper,
      ._container_mlx7l_1, ._moment_mlx7l_10 {
        display: flex !important;
        visibility: visible !important;
        opacity: 1 !important;
        pointer-events: auto !important;
      }

      /* Let internal board elements use their own NYT display properties (e.g. CSS grid) */
      .Game-module_board__s7aFK, .Game-module_boardContainer__VZu4G,
      .Cards-module_cardsContainer__O3T5q {
        visibility: visible !important;
        opacity: 1 !important;
        pointer-events: auto !important;
      }
      .pz-game-wrapper, .pz-game-screen, #pz-game-root, .pz-game-field { width: 100%; height: 100%; display: flex !important; flex: 1; flex-direction: column; background: #3c280d !important; }
      ._container_mlx7l_1 { display: grid !important; grid-template-areas: "stack"; grid-template-rows: 1fr; flex: 1; }
      ._moment_mlx7l_10 { 
        grid-area: stack !important; 
        flex-direction: column !important; 
        align-items: center !important; 
        justify-content: flex-start !important; 
        padding-top: 8px !important;
      }
      .Game-module_board__s7aFK {
        justify-content: flex-start !important;
        height: auto !important;
        flex: 0 1 auto !important;
        margin: 0 auto !important;
        max-width: 540px !important;
        width: 94vw !important;
      }
      .Game-module_form__BCqGO {
        margin: 0 !important;
        width: 100% !important;
      }
      .Game-module_form__BCqGO h2 {
        margin: 0 0 10px 0 !important;
        font-size: 15px !important;
        text-align: center !important;
        color: #e8e8e8 !important;
      }
      .Game-module_boardContainer__VZu4G {
        position: relative !important;
        margin: 0 auto 12px auto !important;
        height: auto !important;
        width: 100% !important;
      }
      .Cards-module_cardsContainer__O3T5q {
        position: static !important;
        height: auto !important;
        width: 100% !important;
        display: grid !important;
        grid-template-columns: repeat(4, 1fr) !important;
        gap: 8px !important;
      }
      .snuggle-solved-container {
        position: absolute !important;
        top: 0 !important;
        left: 0 !important;
        right: 0 !important;
        pointer-events: none !important;
      }
      .Mistakes-module_mistakesWrapper__LGl68 {
        margin-bottom: 8px !important;
      }
      .Game-module_boardActionGroup__JqzYT {
        margin-top: 8px !important;
      }

      /* ── Hide NYT chrome ── */
      .pz-header, .pz-game-toolbar, .pz-game-header, #portal-game-header, .pz-game-title-bar,
      .pz-game-title, .pz-game-date,
      #ad-top, .Ad-module_adContainer__ZAFEc, #dfp-ad-top, .pz-ad-box,
      ._hide_mlx7l_43, .Banner-module_singleIconBanner__LFn3K,
      .WelcomeManager-module_fixedBanner__obgm9, .pz-moment__welcome,
      .connections-oma-cta-wrapper, [data-testid="oma-games-banner-wrapper"],
      .Toolbar-module_header__UFVtL, .ToolbarAdapter-module_toolbarContainer__Ni4KN,
      #js-hook-pz-moment__welcome, .pz-moment__loading,
      .DateLine-module_dateLine__KLBPQ, h1.pz-game-heading
      { display: none !important; }

      /* ── Snuggle status bar ── */
      #yt-status-bar {
        position: fixed; top: 0; left: 0; right: 0; height: var(--yt-bar-h); z-index: 9999;
        background: #3c280d; border-bottom: 1px solid rgba(244, 162, 97, 0.2);
        display: flex; justify-content: space-between; align-items: center;
        padding: 0 16px; color: #fff; box-sizing: border-box;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      }
      .yt-toast {
        position: fixed; top: calc(var(--yt-bar-h) + 12px); left: 50%; transform: translateX(-50%);
        z-index: 10000; background: #876a4b; color: #fff; padding: 10px 16px; border-radius: 4px;
        font: 700 14px/1.2 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
        opacity: 0; pointer-events: none; transition: opacity 0.2s; white-space: nowrap;
      }
      .yt-toast.show { opacity: 1; }

      /* ── Cards: Uniform Squares with Official Font ── */
      .Card-module_label__U_Q2H {
        width: 100% !important;
        aspect-ratio: 1 / 1 !important;
        height: auto !important;
        border-radius: 8px !important;
        background-color: #876a4b !important;
        color: #e8e8e8 !important;
        border: 2px solid #af804f !important;
        cursor: pointer !important;
        display: flex !important;
        justify-content: center !important;
        align-content: center !important;
        align-items: center !important;
        text-align: center !important;
        flex-wrap: wrap !important;
        box-sizing: border-box !important;
        padding: 6px !important;
        font-family: "nyt-franklin", "Clear Sans", "Helvetica Neue", Arial, sans-serif !important;
        font-weight: 700 !important;
        text-transform: uppercase !important;
        font-size: clamp(13px, 1.8vw, 19px) !important;
        line-height: 1.2 !important;
        user-select: none !important;
        -webkit-user-select: none !important;
      }
      .Card-module_label__U_Q2H span {
        font-family: inherit !important;
        color: inherit !important;
        font-size: inherit !important;
        font-weight: inherit !important;
        text-transform: inherit !important;
        line-height: inherit !important;
        pointer-events: none !important;
      }
      .Card-module_label__U_Q2H:has(input:checked) {
        background-color: #af804f !important;
        border-color: #f4a261 !important;
      }
      .Card-module_label__U_Q2H:has(input:checked) span {
        color: #fff !important;
      }

      /* ── Action buttons ── */
      .ActionButton-module_button__IlhXt {
        border: 2px solid rgba(244, 162, 97, 0.5) !important;
        color: #e8e8e8 !important;
        background: transparent !important;
        border-radius: 24px !important;
        font-weight: 700 !important;
      }
      .ActionButton-module_button__IlhXt:not([disabled]):hover {
        background: rgba(244, 162, 97, 0.15) !important;
      }
      .ActionButton-module_button__IlhXt[disabled] { opacity: 0.35 !important; cursor: not-allowed !important; }

      /* ── Mistakes remaining ── */
      .Mistakes-module_mistakesContent__nlijY, [data-testid="mistake-text"] { color: #e8e8e8 !important; }
      .Mistakes-module_bubble__nDlOh {
        background-color: #a0c35a !important;
        border-radius: 50% !important; width: 16px !important; height: 16px !important; display: inline-block !important;
      }

      /* ── Game heading ── */
      .Game-module_board__s7aFK h2 { color: #e8e8e8 !important; }

      /* ── Solved category rows ── */
      .snuggle-solved-container { display: flex !important; flex-direction: column !important; gap: 8px !important; width: 100% !important; }
      .snuggle-solved-row {
        width: 100%; height: calc((min(94vw, 540px) - 24px) / 4); min-height: 50px; border-radius: 8px;
        display: flex; flex-direction: column; justify-content: center; align-items: center;
        text-align: center; text-transform: uppercase; padding: 10px; box-sizing: border-box;
      }
      .snuggle-solved-title { font-weight: 700; font-size: 16px; margin-bottom: 2px; }
      .snuggle-solved-words { font-size: 14px; }
      .level-0 { background-color: #f9df6d; color: #111; }
      .level-1 { background-color: #a0c35a; color: #111; }
      .level-2 { background-color: #b0c4ef; color: #111; }
      .level-3 { background-color: #ba81c5; color: #111; }
      .card-hidden { visibility: hidden !important; pointer-events: none !important; }

      /* ── Shake animation ── */
      .shake { animation: shake 0.5s; }
      @keyframes shake {
        0%, 100% { transform: translateX(0); }
        25%       { transform: translateX(-6px); }
        75%       { transform: translateX(6px); }
      }

      /* ── NYT Animations ── */
      .nyt-bounce { animation-fill-mode: forwards; animation: nyt-bounce ease-in .3s 1; }
      @keyframes nyt-bounce {
        0%, 100% { transform: translateY(0); }
        50%      { transform: translateY(-10px); }
      }
      .delay-0 { animation-delay: 0s; }
      .delay-1 { animation-delay: 0.1s; }
      .delay-2 { animation-delay: 0.2s; }
      .delay-3 { animation-delay: 0.3s; }

      .nyt-color-change {
        transition: background-color 0.4s ease, color 0.4s ease, border-color 0.4s ease !important;
      }
      .nyt-solved-level-0 { background-color: #f9df6d !important; color: #111 !important; border-color: #f9df6d !important; }
      .nyt-solved-level-1 { background-color: #a0c35a !important; color: #111 !important; border-color: #a0c35a !important; }
      .nyt-solved-level-2 { background-color: #b0c4ef !important; color: #111 !important; border-color: #b0c4ef !important; }
      .nyt-solved-level-3 { background-color: #ba81c5 !important; color: #111 !important; border-color: #ba81c5 !important; }
      @keyframes nyt-pulse {
        0% { transform: scale(1); z-index: 4; }
        40% { transform: scale(1.2); }
        70% { transform: scale(1.2); }
        100% { transform: scale(1); z-index: 4; }
      }
      .nyt-pulse { animation: nyt-pulse linear .3s 1; }
      @keyframes nyt-text-fade { 0% { color: transparent; } 100% { color: inherit; } }
    </style>
    <div class="yt-toast" id="yt-toast" role="status" aria-live="polite" aria-atomic="true"></div>
    <div id="yt-status-bar">
      <div style="display:flex; gap:8px; align-items:center;">
        <button type="button" id="yt-back-btn" onclick="location.href='/games/'" aria-label="Back to games" style="display:flex; align-items:center; gap:5px; background:none; border:1px solid rgba(255,255,255,0.18); color:#ccc; padding:5px 10px; border-radius:6px; cursor:pointer; font-size:13px; font-weight:500; transition:background 0.18s, color 0.18s;" onmouseover="this.style.background='rgba(255,255,255,0.08)'; this.style.color='#fff';" onmouseout="this.style.background='none'; this.style.color='#ccc';">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>
          Back
        </button>
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
  `;
  document.body.insertAdjacentHTML('afterbegin', statusBarHtml);

  // small extra styles (loading state before the puzzle arrives)
  const extraStyle = document.createElement('style');
  extraStyle.textContent = `
    .Cards-module_cardsContainer__O3T5q.snuggle-loading { opacity: 0.35; pointer-events: none; }
  `;
  document.head.appendChild(extraStyle);

  const statusDot       = document.getElementById('status-dot');
  const statusLabel     = document.getElementById('status-label');
  const roomCodeDisplay = document.getElementById('room-code-display');
  const copyBtn         = document.getElementById('copy-btn');
  const copiedSpan      = document.getElementById('yt-code-copied');
  const toastEl         = document.getElementById('yt-toast');

  const DOT = { connecting: '#f39c12', online: '#2ecc71', offline: '#e74c3c' };
  function setStatus(kind, text) { statusDot.style.background = DOT[kind]; statusLabel.textContent = text; }
  let peers = 1;
  function showPeers(count) { 
    peers = count; 
    setStatus(count > 1 ? 'online' : 'connecting', count > 1 ? 'Synced with friend!' : 'Waiting'); 
  }
  function peerCount(msg, fallback) { return Number.isFinite(msg.usersCount) ? msg.usersCount : fallback; }

  let toastTimer = null;
  function showToast(text, ms = 1800) {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
  }

  // ───────────────────────── DOM refs ─────────────────────────
  const cardsContainer = document.querySelector('.Cards-module_cardsContainer__O3T5q');
  const solvedContainer = document.createElement('div');
  solvedContainer.className = 'snuggle-solved-container';
  if (cardsContainer) cardsContainer.parentNode.insertBefore(solvedContainer, cardsContainer);

  const shuffleBtn  = document.querySelector('[data-testid="shuffle-btn"]');
  const deselectBtn = document.querySelector('[data-testid="deselect-btn"]');
  const submitBtn   = document.querySelector('[data-testid="submit-btn"]');
  const mistakeBubbles  = Array.from(document.querySelectorAll('[data-testid="mistake-bubble"]'));
  const mistakeCountEl  = document.querySelector('[data-testid="mistake-count"]');

  const allLabels = () => Array.from(document.querySelectorAll('.Card-module_label__U_Q2H'));
  function getCardElement(word) {
    for (const l of allLabels()) if (l.dataset.word === word) return l;
    return null;
  }
  const isHidden = el => el.classList.contains('card-hidden');

  function adjustFontSizes() {
    const labels = allLabels();
    labels.forEach(label => label.style.removeProperty('font-size'));
    labels.forEach(label => {
      if (label.offsetParent === null) return;
      let size = parseFloat(window.getComputedStyle(label).fontSize);
      const overflowing = () => label.scrollWidth > label.clientWidth + 1 || label.scrollHeight > label.clientHeight + 1;
      while (overflowing() && size > 8) {
        size -= 0.5;
        label.style.setProperty('font-size', size + 'px', 'important');
      }
    });
  }
  window.addEventListener('resize', adjustFontSizes);

  // ───────────────────────── puzzle ─────────────────────────
  let dailyData = null;      // { print_date, categories: [{ title, cards: [{ content, position }] }] }
  let solutionMap = {};      // word -> { title, level }
  let puzzleId = null;
  let defaultOrder = [];     // board order for this puzzle, before anyone shuffles

  function validPuzzle(d) {
    if (!d || !Array.isArray(d.categories) || d.categories.length !== 4) return false;
    const seen = new Set();
    for (const c of d.categories) {
      if (!c || typeof c.title !== 'string' || !Array.isArray(c.cards) || c.cards.length !== 4) return false;
      for (const k of c.cards) {
        if (!k || typeof k.content !== 'string' || !k.content || seen.has(k.content)) return false;
        seen.add(k.content);
      }
    }
    return true;
  }

  function hashStr(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }
  const puzzleIdOf = d => hashStr(d.categories.map(c => c.cards.map(k => k.content).sort().join('|')).sort().join('||'));

  // deterministic shuffle (only used if the API gives no usable card positions)
  function seededShuffle(arr, seedStr) {
    let a = parseInt(hashStr(seedStr), 36) >>> 0;
    const rnd = () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
    return out;
  }

  function blankBoard() {
    if (cardsContainer) cardsContainer.classList.add('snuggle-loading');
    allLabels().forEach(label => {
      delete label.dataset.word;
      label.removeAttribute('data-flip-id');
      label.querySelectorAll('span').forEach(s => { s.textContent = ''; });
      const inp = label.querySelector('input');
      if (inp) { inp.value = ''; inp.checked = false; inp.setAttribute('aria-label', ''); }
    });
  }

  function loadPuzzle(data) {
    dailyData = {
      print_date: typeof data.print_date === 'string' ? data.print_date : '',
      categories: data.categories.map(c => ({
        title: String(c.title),
        cards: c.cards.map(k => ({ content: String(k.content), position: k.position })),
      })),
    };
    puzzleId = puzzleIdOf(dailyData);
    solutionMap = {};
    const flat = [];
    dailyData.categories.forEach((cat, level) => cat.cards.forEach(k => {
      solutionMap[k.content] = { title: cat.title, level };
      flat.push(k);
    }));

    const pos = flat.map(k => k.position);
    const goodPositions = pos.every(p => Number.isInteger(p) && p >= 0 && p < 16) && new Set(pos).size === 16;
    defaultOrder = goodPositions
      ? flat.slice().sort((a, b) => a.position - b.position).map(k => k.content)
      : seededShuffle(flat.map(k => k.content), puzzleId);

    allLabels().forEach((label, i) => {
      const word = defaultOrder[i];
      if (!word) return;
      const input = label.querySelector('input');
      label.setAttribute('data-flip-id', word);
      label.dataset.word = word;
      if (input) { input.value = word; input.setAttribute('aria-label', word); input.checked = false; }
      label.querySelectorAll('span').forEach(s => { s.textContent = word; });
    });
    if (cardsContainer) cardsContainer.classList.remove('snuggle-loading');
    setTimeout(adjustFontSizes, 50);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(adjustFontSizes);
    console.log('[connections-sync] Puzzle loaded:', puzzleId, dailyData.print_date || '');
  }

  // If two players somehow hold different puzzles, they must converge on one.
  // Newer print_date wins; otherwise the lower puzzle id wins (same answer on both sides).
  function considerPuzzle(data) {
    if (!validPuzzle(data)) return false;
    const pid = puzzleIdOf(data);
    if (dailyData) {
      if (pid === puzzleId) return false;
      const ours = dailyData.print_date || '';
      const theirs = typeof data.print_date === 'string' ? data.print_date : '';
      const theirsWins = theirs !== ours ? theirs > ours : pid < puzzleId;
      if (!theirsWins) return false;
    }
    hardReset();
    loadPuzzle(data);
    reconcile(false);
    return true;
  }

  async function fetchPuzzleOnce() {
    try {
      const res = await fetch(API_URL, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (!validPuzzle(data)) throw new Error('unexpected puzzle format');
      considerPuzzle(data);
      return true;
    } catch (e) {
      console.warn('[connections-sync] Failed to fetch daily puzzle:', e);
      return false;
    }
  }

  async function ensurePuzzle() {
    let delay = 2000;
    while (!dailyData) {
      if (await fetchPuzzleOnce()) break;
      if (dailyData) break;                       // a friend sent us the puzzle meanwhile
      showToast("Couldn't load today's puzzle — retrying...", 2500);
      await sleep(delay);
      delay = Math.min(Math.round(delay * 1.5), 15000);
    }
    sendHello();                                   // ask a connected friend for the current game state
  }

  // ───────────────────────── shared state (conflict-free) ─────────────────────────
  let clock = 0;
  const tick    = () => ++clock;
  const observe = ts => { if (Array.isArray(ts) && Number.isFinite(ts[0]) && ts[0] > clock) clock = ts[0]; };
  const cmp     = (a, b) => (a[0] - b[0]) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
  const validTs = ts => Array.isArray(ts) && ts.length === 2 && Number.isFinite(ts[0]) && typeof ts[1] === 'string';
  const isWords = (w, min, max) => Array.isArray(w) && w.length >= min && w.length <= max && w.every(x => typeof x === 'string') && new Set(w).size === w.length;

  let selReg   = { ts: [0, ''], words: [] };    // last-writer-wins
  let orderReg = { ts: [0, ''], order: [] };    // last-writer-wins
  const guessLog = [];                           // [{ ts, words(sorted), key }], kept sorted by ts

  function addGuess(ts, words) {
    const w = words.slice().sort();
    const key = w.join('|');
    const existing = guessLog.find(g => g.key === key);
    if (existing) {
      if (cmp(ts, existing.ts) < 0) { existing.ts = ts; guessLog.sort((x, y) => cmp(x.ts, y.ts)); return true; }
      return false;
    }
    guessLog.push({ ts, words: w, key });
    guessLog.sort((x, y) => cmp(x.ts, y.ts));
    return true;
  }

  function hardReset() {
    guessLog.length = 0;
    selReg = { ts: [0, ''], words: [] };
    orderReg = { ts: [0, ''], order: [] };
    rebuildBoard();
    dirty = true;
  }

  // Everything the board shows is computed from the guess log.
  function derive() {
    const events = [];
    const solvedWords = new Set();
    let solved = 0, mistakes = 0, over = false, lost = false;
    for (const g of guessLog) {
      if (over) break;
      if (g.words.some(w => !solutionMap[w] || solvedWords.has(w))) continue;   // unknown or stale guess
      const lv = solutionMap[g.words[0]].level;
      const counts = {};
      g.words.forEach(w => { const l = solutionMap[w].level; counts[l] = (counts[l] || 0) + 1; });
      if (g.words.every(w => solutionMap[w].level === lv)) {
        solved++;
        g.words.forEach(w => solvedWords.add(w));
        events.push({ type: 'solve', key: g.key, level: lv, words: g.words });
      } else {
        mistakes++;
        events.push({ type: 'mistake', key: g.key, words: g.words, oneAway: Object.values(counts).includes(3) });
      }
      if (solved >= 4) over = true;
      else if (mistakes >= MAX_MISTAKES) { over = true; lost = true; }
    }
    return { events, mistakes, over, lost };
  }

  // ───────────────────────── rendering ─────────────────────────
  let selectedCards = new Set();     // effective selection currently shown
  let gameOver = false;
  let isAnimating = false;
  let busy = false, dirty = false, pendingAnimate = false;
  let selDirty = false, orderDirty = false;
  let view = { keys: [], mistakes: 0, over: false };

  function updateButtons() {
    if (gameOver) { [submitBtn, deselectBtn, shuffleBtn].forEach(b => b && (b.disabled = true)); return; }
    const n = selectedCards.size;
    if (submitBtn)   submitBtn.disabled   = (n !== 4 || isAnimating);
    if (deselectBtn) deselectBtn.disabled = (n === 0 || isAnimating);
    if (shuffleBtn)  shuffleBtn.disabled  = isAnimating;
  }

  function applySelection() {
    if (isAnimating) { selDirty = true; return; }
    selDirty = false;
    const eff = [];
    for (const w of selReg.words) {
      const el = getCardElement(w);
      if (el && !isHidden(el) && eff.length < 4 && !eff.includes(w)) eff.push(w);
    }
    selectedCards = new Set(eff);
    allLabels().forEach(l => {
      const inp = l.querySelector('input');
      if (inp) inp.checked = selectedCards.has(l.dataset.word);
    });
    updateButtons();
  }

  function applyOrder() {
    if (isAnimating) { orderDirty = true; return; }
    orderDirty = false;
    if (!cardsContainer) return;
    for (const w of orderReg.order) {
      const el = getCardElement(w);
      if (el && !isHidden(el)) cardsContainer.appendChild(el);
    }
  }

  function rebuildBoard() {
    solvedContainer.textContent = '';
    allLabels().forEach(l => {
      l.classList.remove('card-hidden', 'nyt-color-change', 'nyt-bounce', 'shake',
        'delay-0', 'delay-1', 'delay-2', 'delay-3',
        'nyt-solved-level-0', 'nyt-solved-level-1', 'nyt-solved-level-2', 'nyt-solved-level-3');
      l.style.transform = '';
      l.style.transition = '';
    });
    if (cardsContainer) defaultOrder.forEach(w => { const el = getCardElement(w); if (el) cardsContainer.appendChild(el); });
    mistakeBubbles.forEach(b => { b.style.opacity = ''; });
    if (mistakeCountEl) mistakeCountEl.textContent = `${MAX_MISTAKES} mistakes remaining out of ${MAX_MISTAKES}`;
    view = { keys: [], mistakes: 0, over: false };
    gameOver = false;
    isAnimating = false;
  }

  async function showSolved(ev, animate) {
    const level = ev.level;
    const title = dailyData.categories[level].title;
    const els = ev.words.map(getCardElement).filter(Boolean);

    // ── Shared: reorder DOM so ghost slots align with overlay rows ──
    // Sort solved cards left-to-right (for consistent column ordering).
    // Then: hidden ghosts first → these solved cards → hidden ghosts again in front.
    // Result: row 0..(N-1) = old ghost slots, row N = this group's ghost slots.
    function reorderSolvedInDOM(sortedEls) {
      if (!cardsContainer) return;
      const hiddenEls = allLabels().filter(l => isHidden(l) && !sortedEls.includes(l));
      for (let i = hiddenEls.length - 1; i >= 0; i--) cardsContainer.prepend(hiddenEls[i]);
      for (let i = sortedEls.length - 1; i >= 0; i--) cardsContainer.prepend(sortedEls[i]);
      for (let i = hiddenEls.length - 1; i >= 0; i--) cardsContainer.prepend(hiddenEls[i]);
    }

    if (animate) {
      isAnimating = true;
      updateButtons();

      // ── Phase 1: Bounce (staggered) ──────────────────────────────
      els.forEach((el, i) => {
        const inp = el.querySelector('input'); if (inp) inp.checked = true;
        el.classList.remove('nyt-bounce', 'delay-0', 'delay-1', 'delay-2', 'delay-3');
        void el.offsetWidth;
        el.classList.add('nyt-bounce', `delay-${i % 4}`);
      });
      await sleep(700);

      // ── Phase 2: FLIP — slide cards into solved-row position ──────
      // Snapshot "First" — current visual positions of the solved cards
      const firstRects = new Map();
      els.forEach(el => firstRects.set(el, el.getBoundingClientRect()));

      // Sort solved cards left-to-right so they land L→R in the target row
      const sortedEls = els.slice().sort((a, b) => firstRects.get(a).left - firstRects.get(b).left);

      // Compute the exact pixel target for each card.
      const containerRect = cardsContainer ? cardsContainer.getBoundingClientRect() : { top: 0, left: 0 };
      const sampleRect = firstRects.get(sortedEls[0]) || sortedEls[0].getBoundingClientRect();
      const cardW = sampleRect.width;
      const cardH = sampleRect.height;
      const gapPx = 8;
      const rowH = cardH + gapPx;
      const solvedRowCount = solvedContainer.children.length;
      const targetTop  = containerRect.top  + solvedRowCount * rowH;
      const targetLeft = containerRect.left;

      // Freeze each solved card at its current visual position via translate
      sortedEls.forEach((el, i) => {
        const first = firstRects.get(el);
        const dx = first.left - (targetLeft + i * (cardW + gapPx));
        const dy = first.top  - targetTop;
        el.style.transition = 'none';
        el.style.transform  = `translate(${dx}px, ${dy}px)`;
      });

      // Reorder DOM (invisible because of translate freeze)
      reorderSolvedInDOM(sortedEls);

      await nextFrame();
      await nextFrame();

      // Animate each card to its grid slot
      sortedEls.forEach(el => {
        el.style.transition = 'transform 0.4s cubic-bezier(0.4,0,0.2,1)';
        el.style.transform = 'translate(0, 0)';
      });
      await sleep(450);

      // ── Phase 3: Color change ─────────────────────────────────────
      sortedEls.forEach(el => {
        const inp = el.querySelector('input'); if (inp) inp.checked = false;
        el.style.transition = '';
        el.style.transform = '';
        el.classList.add('nyt-color-change', `nyt-solved-level-${level}`);
      });
      await sleep(500);
    } else {
      // Non-animated path (snapshot restore on refresh):
      // Still reorder DOM so ghost slots sit in the right grid rows
      // and align with the absolute-positioned solved overlay rows.
      const sortedEls = els.slice().sort((a, b) => {
        // Sort by current DOM index as a proxy for left-to-right column order
        const all = allLabels();
        return all.indexOf(a) - all.indexOf(b);
      });
      els.forEach(el => {
        const inp = el.querySelector('input'); if (inp) inp.checked = false;
        el.style.transition = '';
        el.style.transform = '';
      });
      reorderSolvedInDOM(sortedEls);
    }

    els.forEach(el => el.classList.add('card-hidden'));

    const row = document.createElement('div');
    row.className = `snuggle-solved-row level-${level}`;
    const t = document.createElement('div'); t.className = 'snuggle-solved-title'; t.textContent = title;
    const w = document.createElement('div'); w.className = 'snuggle-solved-words'; w.textContent = ev.words.join(', ');
    row.append(t, w);
    if (animate) { row.classList.add('nyt-pulse'); t.style.animation = 'nyt-text-fade 0.5s'; w.style.animation = 'nyt-text-fade 0.5s'; }
    solvedContainer.appendChild(row);
    // animation done

    isAnimating = false;
    setTimeout(adjustFontSizes, 0);
  }

  async function showMistake(ev, animate) {
    view.mistakes++;
    const idx = MAX_MISTAKES - view.mistakes;
    if (mistakeBubbles[idx]) mistakeBubbles[idx].style.opacity = '0.2';
    if (mistakeCountEl) mistakeCountEl.textContent = `${Math.max(0, idx)} mistakes remaining out of ${MAX_MISTAKES}`;
    if (!animate) return;
    isAnimating = true;
    updateButtons();
    showToast(ev.oneAway ? 'One away...' : 'Not quite.');
    ev.words.forEach(w => {
      const el = getCardElement(w);
      if (el) { el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); }
    });
    await sleep(600);
    isAnimating = false;
  }

  // Brings the screen in line with the guess log. Serialised: only one run at a time.
  async function reconcile(animate) {
    pendingAnimate = animate;
    if (busy) { dirty = true; return; }
    if (!dailyData) return;
    busy = true;
    try {
      do {
        dirty = false;
        const d = derive();
        const keyOf = e => e.type + ':' + e.key;
        const prefixOk = view.keys.length <= d.events.length
          && view.keys.every((k, i) => k === keyOf(d.events[i]))
          && !(view.over && !d.over);
        let anim = pendingAnimate;
        if (!prefixOk) { rebuildBoard(); anim = false; }

        for (let i = view.keys.length; i < d.events.length; i++) {
          if (dirty) break;
          const ev = d.events[i];
          if (ev.type === 'solve') await showSolved(ev, anim); else await showMistake(ev, anim);
          view.keys.push(keyOf(ev));
        }
        if (dirty) continue;

        gameOver = d.over;
        updateButtons();
        if (d.over && !view.over) {
          if (d.lost) {
            const solvedLevels = new Set(d.events.filter(e => e.type === 'solve').map(e => e.level));
            for (let level = 0; level < 4; level++) {
              if (solvedLevels.has(level)) continue;
              if (dirty) break;
              const words = dailyData.categories[level].cards.map(c => c.content);
              const first = getCardElement(words[0]);
              if (first && isHidden(first)) continue;                         // already revealed
              await showSolved({ level, words }, anim);
            }
            if (dirty) continue;
            showToast('Game Over', 5000);
          } else {
            showToast(d.mistakes === 0 ? 'Perfect!' : 'Solved!', 5000);
          }
          view.over = true;
        }
      } while (dirty);
    } catch (err) {
      console.error('[connections-sync] render error:', err);
    } finally {
      busy = false;
      isAnimating = false;
      applyOrder();
      applySelection();
      updateButtons();
    }
  }

  // ───────────────────────── local actions ─────────────────────────
  function setSelection(words) {
    selReg = { ts: [tick(), CLIENT_ID], words };
    send({ kind: 'sel', pid: puzzleId, ts: selReg.ts, words });
    applySelection();
  }

  function localSelect(word) {
    if (gameOver || isAnimating) return;
    const next = new Set(selectedCards);
    if (next.has(word)) next.delete(word);
    else { if (next.size >= 4) return; next.add(word); }
    setSelection([...next]);
  }

  function localDeselectAll() {
    if (gameOver || isAnimating || selectedCards.size === 0) return;
    setSelection([]);
  }

  function localShuffle() {
    if (gameOver || isAnimating) return;
    const words = allLabels().filter(l => l.dataset.word && !isHidden(l)).map(l => l.dataset.word);
    for (let i = words.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [words[i], words[j]] = [words[j], words[i]];
    }
    orderReg = { ts: [tick(), CLIENT_ID], order: words };
    send({ kind: 'order', pid: puzzleId, ts: orderReg.ts, order: words });
    applyOrder();
  }

  function localSubmit() {
    if (gameOver || isAnimating || selectedCards.size !== 4) return;
    const words = [...selectedCards].sort();
    const key = words.join('|');
    if (guessLog.some(g => g.key === key)) { showToast('Already guessed!'); return; }
    const ts = [tick(), CLIENT_ID];
    addGuess(ts, words);
    send({ kind: 'guess', pid: puzzleId, ts, words });
    const lv = solutionMap[words[0]].level;
    if (words.every(w => solutionMap[w].level === lv)) setSelection([]);   // correct → clear everyone's selection
    reconcile(true);
    // Push a full snapshot so the server persists current state for refresh recovery
    setTimeout(sendSnapshot, 100);
  }

  // ───────────────────────── networking ─────────────────────────
  const requestedCode = (new URLSearchParams(window.location.search).get('code') || '').trim() || null;
  let ws = null, roomCode = null, joining = false, reconnectTimer = null;

  function rawSend(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify(obj)); } catch (_) {} }
  }
  // Payload travels inside `action` so it passes through a relay that only forwards known fields.
  function send(action) { if (roomCode) rawSend({ type: 'game_sync', from: CLIENT_ID, action }); }

  function syncUrl() {
    try {
      const u = new URL(window.location.href);
      let needsUpdate = false;
      for (const key of Array.from(u.searchParams.keys())) {
        if (key !== 'code') { u.searchParams.delete(key); needsUpdate = true; }
      }
      if (u.searchParams.get('code') !== roomCode) {
        if (roomCode) u.searchParams.set('code', roomCode);
        else u.searchParams.delete('code');
        needsUpdate = true;
      }
      if (needsUpdate) window.history.replaceState(null, '', u);
    } catch (_) {}
  }

  function snapshot() {
    return {
      kind: 'state', pid: puzzleId, puzzle: dailyData, clock,
      sel: selReg, order: orderReg,
      guesses: guessLog.map(g => ({ ts: g.ts, words: g.words })),
    };
  }
  function sendSnapshot() { if (roomCode && dailyData) send(snapshot()); }
  function sendHello()    { if (roomCode) send({ kind: 'hello' }); }

  function mergeState(m) {
    if (m.puzzle) considerPuzzle(m.puzzle);
    if (!dailyData || m.pid !== puzzleId) return;
    if (Number.isFinite(m.clock)) observe([m.clock, '']);

    let selChanged = false, orderChanged = false, guessesChanged = false;
    if (m.sel && validTs(m.sel.ts) && isWords(m.sel.words, 0, 4)) {
      observe(m.sel.ts);
      if (cmp(m.sel.ts, selReg.ts) > 0) { selReg = { ts: m.sel.ts, words: m.sel.words.slice() }; selChanged = true; }
    }
    if (m.order && validTs(m.order.ts) && isWords(m.order.order, 0, 16)) {
      observe(m.order.ts);
      if (cmp(m.order.ts, orderReg.ts) > 0) { orderReg = { ts: m.order.ts, order: m.order.order.slice() }; orderChanged = true; }
    }
    if (Array.isArray(m.guesses)) {
      for (const g of m.guesses) {
        if (g && validTs(g.ts) && isWords(g.words, 4, 4)) { observe(g.ts); if (addGuess(g.ts, g.words)) guessesChanged = true; }
      }
    }
    if (guessesChanged) reconcile(false);      // catching up from a snapshot: no animation
    if (orderChanged) applyOrder();
    if (selChanged || guessesChanged) applySelection();
  }

  function onGameSync(msg) {
    if (msg.from && msg.from === CLIENT_ID) return;
    const a = msg.action;
    if (!a || typeof a !== 'object') return;
    if (validTs(a.ts)) observe(a.ts);

    switch (a.kind) {
      case 'hello': sendSnapshot(); return;
      case 'state': mergeState(a); return;
    }
    if (!dailyData || a.pid !== puzzleId) return;     // live updates only apply to the same puzzle

    if (a.kind === 'sel' && validTs(a.ts) && isWords(a.words, 0, 4)) {
      if (cmp(a.ts, selReg.ts) > 0) { selReg = { ts: a.ts, words: a.words.slice() }; applySelection(); }
    } else if (a.kind === 'order' && validTs(a.ts) && isWords(a.order, 0, 16)) {
      if (cmp(a.ts, orderReg.ts) > 0) { orderReg = { ts: a.ts, order: a.order.slice() }; applyOrder(); }
    } else if (a.kind === 'guess' && validTs(a.ts) && isWords(a.words, 4, 4)) {
      if (addGuess(a.ts, a.words)) reconcile(true);
    }
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'room_created': case 'room_joined':
        joining = false; roomCode = msg.code || roomCode;
        localStorage.setItem('snuggle_last_room_code', roomCode);
        roomCodeDisplay.textContent = roomCode; syncUrl();
        showPeers(peerCount(msg, msg.type === 'room_joined' ? 2 : 1));
        if (msg.type === 'room_joined') { sendSnapshot(); sendHello(); }
        if (window.snuggleTrack) { snuggleTrack(msg.type === 'room_created' ? 'room_create' : 'room_join', { roomCode, section: 'connections' }); snuggleTrack('game_play', { game: 'connections', action: msg.type === 'room_created' ? 'create' : 'join', roomCode }); }
        break;
      case 'user_joined': showPeers(peerCount(msg, 2)); sendSnapshot(); break;
      case 'user_left':   showPeers(peerCount(msg, 1)); break;
      case 'game_sync':   onGameSync(msg); break;
      default:
        if (joining && /error|not.?found|invalid|fail/i.test(`${msg.type} ${msg.message || ''}`)) {
          joining = false; roomCode = null;
          setStatus('online', 'Room not found — creating a new one...');
          rawSend({ type: 'create_room' });
        }
    }
  }

  function connect() {
    clearTimeout(reconnectTimer);
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') {
      setStatus('offline', 'Offline (open via your server to play together)'); return;
    }
    let socket;
    try {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${proto}//${window.location.host}`);
    } catch (err) { console.error('[connections-sync] WS failed:', err); setStatus('offline', 'Offline (solo mode)'); return; }
    ws = socket;
    socket.onopen = () => {
      const code = roomCode || requestedCode;
      if (code) { joining = true; setStatus('online', 'Joining room...'); rawSend({ type: 'join_room', code }); }
      else      { setStatus('online', 'Creating room...'); rawSend({ type: 'create_room' }); }
    };
    socket.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (m && typeof m === 'object') handleMessage(m);
    };
    socket.onclose = () => {
      if (ws !== socket) return;
      setStatus('offline', 'Disconnected — reconnecting...');
      reconnectTimer = setTimeout(connect, 3000);
    };
  }

  // phones silently kill sockets when the tab is backgrounded — reconnect as soon as we're back
  function wake() { if (!ws || ws.readyState !== WebSocket.OPEN) connect(); else sendSnapshot(); }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wake(); });
  window.addEventListener('online', wake);
  window.addEventListener('pageshow', wake);

  // anti-entropy: a periodic snapshot repairs anything a dropped message left behind
  setInterval(() => { if (peers > 1) sendSnapshot(); }, SNAPSHOT_MS);

  // ───────────────────────── input ─────────────────────────
  document.addEventListener('submit', e => e.preventDefault());

  document.addEventListener('click', e => {
    const label = e.target.closest('.Card-module_label__U_Q2H');
    if (label) {
      e.preventDefault();
      const word = label.dataset.word;
      if (word) localSelect(word);
      else showToast('Puzzle still loading...');
      return;
    }
    const btn = e.target.closest('button');
    if (!btn) return;
    e.preventDefault();
    if (btn === shuffleBtn)       { btn.blur(); localShuffle(); }
    else if (btn === deselectBtn) { btn.blur(); localDeselectAll(); }
    else if (btn === submitBtn)   { btn.blur(); localSubmit(); }
  });

  // ───────────────────────── copy link ─────────────────────────
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (_) {}
    try {
      const ta = Object.assign(document.createElement('textarea'), { value: text, readOnly: true });
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy'); ta.remove(); return ok;
    } catch (_) { return false; }
  }

  let copiedTimer = null;
  copyBtn.addEventListener('click', async () => {
    copyBtn.blur();
    if (!roomCode) { showToast('Room not ready yet'); return; }
    const url = window.location.href;
    if (navigator.share) {
      try { await navigator.share({ title: 'Join my room', url }); return; } catch (e) {}
    }
    if (!(await copyText(url))) { showToast('Copy failed — copy the link from the address bar', 3000); return; }
    roomCodeDisplay.style.display = 'none'; copiedSpan.style.display = 'inline';
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { copiedSpan.style.display = 'none'; roomCodeDisplay.style.display = ''; }, 2000);
  });

  // ───────────────────────── go ─────────────────────────
  syncUrl();
  blankBoard();          // don't show the stale puzzle baked into the saved page
  updateButtons();
  connect();             // connect right away so a friend can send us the puzzle if our fetch fails
  ensurePuzzle();
})();
