/* =============================================
   SNUGGLE - GesturePlayer (v2)
   Local-file video player used by the Local Video room.

   Public API (kept compatible with the previous version):
     new GesturePlayer(container, { title, allowLocalFile, allowLocalSubtitle, seekSeconds, src, sources, subtitleUrl })
     player.$.video / player.container
     player.setSubtitleOffset(seconds)
     player.loadLocalVideoFile(file) / player.loadLocalSubtitleFile(file)

   New in v2:
     player.loadSubtitleText(text, { name, source })    source: 'local' (shared with friend) | 'remote'
     player.getSubtitle()  ->  { name, text, source } | null
     player.nudgeOffset(delta)
     player.isSwapping     true while a file is loading (suppress outgoing sync)
     player.fileInfo       { name, size, duration }
   Events on player.container (CustomEvent):
     filechosen        { name, size }
     videoready        { name, size, duration }
     subtitleload      { name, text }      user picked / extracted a subtitle (share it)
     subtitleoffsetchange  detail = seconds (number) - user changed the offset (share it)
   ============================================= */
(function (global) {
  'use strict';

  /* ---------------------------------------------------------------
     Small helpers
  --------------------------------------------------------------- */
  const LS = {
    get(k, d) { try { const v = localStorage.getItem('snuggle.mv.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('snuggle.mv.' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  };
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

  function fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    s = Math.floor(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const p = (n) => (n < 10 ? '0' + n : '' + n);
    return h ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
  }

  function fmtBytes(n) {
    if (n > 1e9) return (n / 1e9).toFixed(1) + ' GB';
    return Math.round(n / 1e6) + ' MB';
  }

  /* ---------------------------------------------------------------
     Subtitle engine (pure functions, no DOM)
  --------------------------------------------------------------- */
  const ENCODINGS = [
    ['auto', 'Auto-detect'],
    ['utf-8', 'Unicode (UTF-8)'],
    ['windows-1252', 'Western (Windows-1252)'],
    ['windows-1256', 'Arabic / Urdu (Windows-1256)'],
    ['windows-1251', 'Cyrillic (Windows-1251)'],
    ['windows-1254', 'Turkish (Windows-1254)'],
    ['windows-1253', 'Greek (Windows-1253)'],
    ['windows-1255', 'Hebrew (Windows-1255)'],
    ['windows-874', 'Thai (Windows-874)'],
    ['gbk', 'Chinese (GBK)'],
    ['big5', 'Chinese Traditional (Big5)'],
    ['shift_jis', 'Japanese (Shift-JIS)'],
    ['euc-kr', 'Korean (EUC-KR)']
  ];

  function decodeBytes(bytes, encoding) {
    encoding = encoding || 'auto';
    if (encoding === 'auto') {
      if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) encoding = 'utf-16le';
      else if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) encoding = 'utf-16be';
      else {
        try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' }; }
        catch (e) { encoding = 'windows-1252'; }
      }
    }
    let text;
    try { text = new TextDecoder(encoding).decode(bytes); }
    catch (e) { text = new TextDecoder('utf-8').decode(bytes); encoding = 'utf-8'; }
    return { text, encoding };
  }

  const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&nbsp;': ' ', '&quot;': '"', '&#39;': "'" };

  /* Keep <i> <b> <u>, drop everything else (font tags, ASS {\an8} overrides ...). */
  function cleanCueText(t) {
    return t
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\N/g, '\n').replace(/\\n/g, '\n').replace(/\\h/g, ' ')
      .replace(/<(?!\/?[ibu]>)[^>]*>/gi, '')
      .replace(/&(amp|lt|gt|nbsp|quot|#39);/g, (m) => ENTITIES[m] || m)
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  const TS_RE = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
  const toSec = (h, m, s, ms) => (+h || 0) * 3600 + (+m) * 60 + (+s) + (+((ms + '00').slice(0, 3))) / 1000;

  function parseSrtVtt(text) {
    const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
    const cues = [];
    let cur = null;
    const flush = () => {
      if (cur) {
        const t = cleanCueText(cur.lines.join('\n'));
        if (t) cues.push({ start: cur.start, end: cur.end, text: t });
      }
      cur = null;
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const m = TS_RE.exec(line);
      if (m) {
        if (cur && cur.lines.length && /^\d+$/.test(cur.lines[cur.lines.length - 1].trim())) cur.lines.pop();  // index of the next cue
        flush();
        cur = { start: toSec(m[1], m[2], m[3], m[4]), end: toSec(m[5], m[6], m[7], m[8]), lines: [] };
      } else if (cur) {
        if (line.trim() === '') flush();
        else cur.lines.push(line);
      }
    }
    flush();
    return cues;
  }

  function parseAss(text) {
    const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
    let inEvents = false, fmt = null;
    const cues = [];
    const assTime = (s) => { const m = /(\d+):(\d{1,2}):(\d{2})[.](\d{1,3})/.exec(s.trim()); return m ? toSec(m[1], m[2], m[3], m[4]) : NaN; };
    for (const raw of lines) {
      const line = raw.trim();
      if (/^\[events\]/i.test(line)) { inEvents = true; continue; }
      if (/^\[/.test(line)) { inEvents = false; continue; }
      if (!inEvents) continue;
      if (/^format:/i.test(line)) { fmt = line.slice(7).split(',').map((s) => s.trim().toLowerCase()); continue; }
      if (!/^dialogue:/i.test(line) || !fmt) continue;
      const body = line.slice(9).trimStart();
      const parts = [];
      let rest = body;
      for (let i = 0; i < fmt.length - 1; i++) {
        const idx = rest.indexOf(',');
        if (idx < 0) break;
        parts.push(rest.slice(0, idx)); rest = rest.slice(idx + 1);
      }
      parts.push(rest);
      const get = (k) => parts[fmt.indexOf(k)];
      const start = assTime(get('start') || ''), end = assTime(get('end') || '');
      let txt = get('text') || '';
      if (isNaN(start) || isNaN(end) || /\\p[1-9]/.test(txt)) continue;      // skip vector drawings
      txt = cleanCueText(txt);
      if (txt) cues.push({ start, end, text: txt });
    }
    return cues;
  }

  function parseSubtitles(text) {
    const cues = (/\[events\]/i.test(text) && /^\s*dialogue:/im.test(text)) ? parseAss(text) : parseSrtVtt(text);
    cues.sort((a, b) => a.start - b.start);
    cues.forEach((c, i) => { c.i = i; });
    return cues;
  }

  /* All cues visible at time t (cues sorted by start). */
  function cuesAt(cues, t) {
    let lo = 0, hi = cues.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    const out = [];
    for (let i = idx; i >= 0 && i > idx - 8; i--) if (cues[i].end > t) out.unshift(cues[i]);
    return out;
  }

  function appendText(node, text) {
    text.split('\n').forEach((part, i) => {
      if (i) node.appendChild(document.createElement('br'));
      if (part) node.appendChild(document.createTextNode(part));
    });
  }

  /* Build DOM from cue text without ever touching innerHTML. */
  function renderCueInto(node, text) {
    const stack = [node];
    const re = /<(\/?)(i|b|u)>/gi;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) appendText(stack[stack.length - 1], text.slice(last, m.index));
      if (!m[1]) {
        const e = document.createElement(m[2].toLowerCase());
        stack[stack.length - 1].appendChild(e); stack.push(e);
      } else if (stack.length > 1 && stack[stack.length - 1].tagName.toLowerCase() === m[2].toLowerCase()) {
        stack.pop();
      }
      last = re.lastIndex;
    }
    if (last < text.length) appendText(stack[stack.length - 1], text.slice(last));
  }

  /* ---------------------------------------------------------------
     Icons
  --------------------------------------------------------------- */
  const I = (inner, fill) => `<svg viewBox="0 0 24 24" width="24" height="24" fill="${fill ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  const ICON = {
    play: I('<polygon points="7 4 20 12 7 20 7 4"/>', true),
    pause: I('<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>', true),
    replay: I('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'),
    back: I('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><text x="12" y="15.5" font-size="7.5" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none" font-family="Inter,sans-serif">10</text>'),
    fwd: I('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/><text x="12" y="15.5" font-size="7.5" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none" font-family="Inter,sans-serif">10</text>'),
    vol: I('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/>'),
    volLow: I('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>'),
    mute: I('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/>'),
    cc: I('<rect x="2.5" y="5" width="19" height="14" rx="3"/><path d="M7 11h3M7 15h5M14 11h3M15 15h2"/>'),
    fs: I('<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>'),
    fsExit: I('<path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/>'),
    close: I('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
    sun: I('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
    film: I('<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4"/>'),
    file: I('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
    alert: I('<circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12.5"/><circle cx="12" cy="16" r="0.6" fill="currentColor"/>')
  };

  const SWATCHES = ['#ffffff', '#ffe14d', '#7ce8f5', '#8dffa8', '#ff9bd8'];
  const DEFAULT_STYLE = { size: 100, color: '#ffffff', opacity: 100, bg: 55 };

  /* ---------------------------------------------------------------
     GesturePlayer
  --------------------------------------------------------------- */
  class GesturePlayer {
    constructor(container, options) {
      this.container = container;
      this.opts = Object.assign({
        title: '', allowLocalFile: true, allowLocalSubtitle: true, seekSeconds: 10,
        src: null, sources: null, subtitleUrl: null, poster: null
      }, options || {});

      this.state = {
        subtitleOffset: 0,
        subtitlesOn: true,
        brightness: 1,
        style: Object.assign({}, DEFAULT_STYLE, LS.get('substyle', {})),
        controlsVisible: true,
        sheetTab: 'subs'
      };
      this.sub = { cues: [], name: '', text: '', source: 'local', bytes: null, encoding: null };
      this.fileInfo = { name: '', size: 0, duration: 0 };
      this._mkv = null;
      this._audioIndex = null;
      this._file = null;
      this._token = 0;
      this._swapLock = false;
      this._url = null;
      this._subKey = null;
      this._chain = null;
      this._lastTap = null;
      this._hls = null;
      this._alive = true;
      this._cleanups = [];

      this._build();
      this._bind();
      this._applyStyle();
      this._renderOffset();
      this._renderSheetState();
      this._setTab('subs');

      const vol = LS.get('volume', 1);
      this.$.video.volume = clamp(vol, 0, 1);
      this._syncVolumeUI();

      if (this.opts.title) this.setTitle(this.opts.title);
      if (this.opts.src) this.loadSource(this.opts.src);
      if (this.opts.subtitleUrl) this._loadSubtitleUrl(this.opts.subtitleUrl);
    }

    get isSwapping() { return this._swapLock; }

    /* -------------------------------------------------------------
       DOM
    ------------------------------------------------------------- */
    _build() {
      const o = this.opts;
      this.container.innerHTML = `
<div class="gp" data-state="empty" tabindex="-1">
  <video class="gp-video" playsinline webkit-playsinline preload="auto"></video>
  <div class="gp-dim" data-r="dim"></div>
  <div class="gp-zones" data-r="zones"></div>
  <div class="gp-subs" data-r="subs" aria-live="off"><div class="gp-sub" data-r="subText"></div></div>

  <div class="gp-ripple gp-ripple--left" data-r="rippleL"><div class="gp-ripple__body">${ICON.back}<span data-r="rippleLText">10 seconds</span></div></div>
  <div class="gp-ripple gp-ripple--right" data-r="rippleR"><div class="gp-ripple__body">${ICON.fwd}<span data-r="rippleRText">10 seconds</span></div></div>
  <div class="gp-pulse" data-r="pulse"></div>
  <div class="gp-hud" data-r="hud" role="status"></div>
  <div class="gp-meter gp-meter--left" data-r="meterB">${ICON.sun}<div class="gp-meter__bar"><i data-r="meterBFill"></i></div></div>
  <div class="gp-meter gp-meter--right" data-r="meterV">${ICON.vol}<div class="gp-meter__bar"><i data-r="meterVFill"></i></div></div>
  <div class="gp-spinner" data-r="spinner" aria-hidden="true"></div>

  <div class="gp-top" data-r="top"><span class="gp-title" data-r="title"></span></div>
  <button type="button" class="gp-bigplay" data-r="bigplay" aria-label="Play">${ICON.play}</button>

  <div class="gp-controls" data-r="controls">
    <div class="gp-seekwrap" data-r="seekWrap">
      <div class="gp-seektip" data-r="seekTip">0:00</div>
      <input class="gp-range gp-seek" data-r="seek" type="range" min="0" max="1000" step="1" value="0" aria-label="Seek">
    </div>
    <div class="gp-row">
      <button type="button" class="gp-btn-i" data-r="btnPlay" aria-label="Play (K)" title="Play / pause (Space)">${ICON.play}</button>
      <button type="button" class="gp-btn-i gp-hide-sm" data-r="btnBack" aria-label="Back ${o.seekSeconds} seconds" title="Back ${o.seekSeconds} s (J)">${ICON.back}</button>
      <button type="button" class="gp-btn-i gp-hide-sm" data-r="btnFwd" aria-label="Forward ${o.seekSeconds} seconds" title="Forward ${o.seekSeconds} s (L)">${ICON.fwd}</button>
      <div class="gp-vol">
        <button type="button" class="gp-btn-i" data-r="btnMute" aria-label="Mute (M)" title="Mute (M)">${ICON.vol}</button>
        <input class="gp-range gp-volrange" data-r="vol" type="range" min="0" max="1" step="0.01" value="1" aria-label="Volume">
      </div>
      <span class="gp-time" data-r="time">0:00 / 0:00</span>
      <span class="gp-spacer"></span>
      <button type="button" class="gp-btn-i gp-btn-cc" data-r="btnSubs" aria-label="Subtitles and audio (S)" title="Subtitles (S)">${ICON.cc}<i class="gp-dot" data-r="subDot"></i></button>
      <button type="button" class="gp-btn-i" data-r="btnFs" aria-label="Fullscreen (F)" title="Fullscreen (F)">${ICON.fs}</button>
    </div>
  </div>

  <div class="gp-backdrop" data-r="backdrop"></div>
  <aside class="gp-sheet" data-r="sheet" role="dialog" aria-label="Subtitles and audio" aria-hidden="true">
    <div class="gp-sheet__grab" aria-hidden="true"></div>
    <header class="gp-sheet__head">
      <div class="gp-tabs" role="tablist" data-r="tabs">
        <button type="button" role="tab" class="gp-tab" data-tab="subs">Subtitles</button>
        <button type="button" role="tab" class="gp-tab" data-tab="audio" data-r="tabAudio" hidden>Audio</button>
        <button type="button" role="tab" class="gp-tab" data-tab="quality" data-r="tabQuality" hidden>Quality</button>
      </div>
      <button type="button" class="gp-btn-i gp-sheet__close" data-r="sheetClose" aria-label="Close">${ICON.close}</button>
    </header>

    <div class="gp-sheet__body">
      <section class="gp-panel" data-panel="subs">
        <div class="gp-sec">
          <div class="gp-sec__head">
            <h3>Subtitle file</h3>
            <label class="gp-switch"><input type="checkbox" data-r="subToggle" checked><span class="gp-switch__track"></span><span class="gp-switch__text">Show</span></label>
          </div>
          <button type="button" class="gp-btn gp-btn--primary" data-r="btnPickSub">${ICON.file}<span>Choose subtitle file</span></button>
          <p class="gp-subinfo" data-r="subInfo">No subtitles yet. Supports SRT, VTT and ASS. Your friend gets the file automatically.</p>
          <div class="gp-embed" data-r="embedWrap" hidden>
            <div class="gp-label">Inside this video</div>
            <div class="gp-list" data-r="embedList"></div>
          </div>
          <label class="gp-enc" data-r="encWrap" hidden>
            <span>Text looks garbled?</span>
            <select data-r="encSel">${ENCODINGS.map((e) => `<option value="${e[0]}">${e[1]}</option>`).join('')}</select>
          </label>
        </div>

        <div class="gp-sec">
          <div class="gp-sec__head">
            <h3>Timing</h3>
            <span class="gp-badge gp-badge--shared">Shared with your friend</span>
          </div>
          <div class="gp-stepper">
            <button type="button" class="gp-step" data-r="offMinus" aria-label="Show subtitles earlier by 0.5 seconds"><span aria-hidden="true">&minus;</span></button>
            <div class="gp-stepper__mid">
              <input class="gp-offset" data-r="offInput" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" value="0.0" aria-label="Subtitle offset in seconds">
              <span class="gp-stepper__unit">seconds</span>
            </div>
            <button type="button" class="gp-step" data-r="offPlus" aria-label="Show subtitles later by 0.5 seconds"><span aria-hidden="true">+</span></button>
          </div>
          <p class="gp-offset-note" data-r="offNote">No shift</p>
          <div class="gp-offset-foot">
            <span>Hold &minus; or + to go faster. You can also type a number.</span>
            <button type="button" class="gp-link" data-r="offReset">Reset</button>
          </div>
        </div>

        <div class="gp-sec">
          <div class="gp-sec__head">
            <h3>Appearance</h3>
            <span class="gp-badge">Only on your screen</span>
          </div>
          <div class="gp-preview"><span class="gp-preview__text" data-r="preview">The quick brown fox</span></div>
          <label class="gp-field"><span>Size</span><input class="gp-slider" data-r="stSize" type="range" min="50" max="250" step="5"><output data-r="stSizeOut"></output></label>
          <label class="gp-field"><span>Opacity</span><input class="gp-slider" data-r="stOpacity" type="range" min="20" max="100" step="5"><output data-r="stOpacityOut"></output></label>
          <label class="gp-field"><span>Background</span><input class="gp-slider" data-r="stBg" type="range" min="0" max="100" step="5"><output data-r="stBgOut"></output></label>
          <div class="gp-field gp-field--colors"><span>Colour</span>
            <div class="gp-swatches" data-r="swatches">
              ${SWATCHES.map((c) => `<button type="button" class="gp-swatch" data-color="${c}" style="--c:${c}" aria-label="Colour ${c}"></button>`).join('')}
              <label class="gp-swatch gp-swatch--custom" title="Custom colour"><input type="color" data-r="stColor"><span aria-hidden="true">+</span></label>
            </div>
          </div>
          <div class="gp-sec__foot"><button type="button" class="gp-link" data-r="stReset">Reset appearance</button></div>
        </div>
      </section>

      <section class="gp-panel" data-panel="audio" hidden>
        <div class="gp-sec">
          <div class="gp-sec__head"><h3>Audio track</h3></div>
          <div class="gp-list" data-r="audioList"></div>
          <p class="gp-subinfo">Changing the track re-prepares the video, which can take a minute for long films. Playback pauses at your current spot.</p>
        </div>
      </section>

      <section class="gp-panel" data-panel="quality" hidden>
        <div class="gp-sec">
          <div class="gp-sec__head"><h3>Quality</h3></div>
          <div class="gp-list" data-r="qualityList"></div>
        </div>
      </section>
    </div>
  </aside>

  <div class="gp-empty" data-r="empty">
    <div class="gp-empty__top">
      <div class="gp-empty__icon">${ICON.film}</div>
    </div>
    <div class="gp-empty__bottom">
      <button type="button" class="gp-btn gp-btn--primary gp-btn--lg" data-r="btnPickVideo">Choose video file</button>
    </div>
  </div>

  <div class="gp-loading" data-r="loading">
    <div class="gp-loading__card">
      <div class="gp-loading__title" data-r="loadTitle">Opening file</div>
      <div class="gp-bar"><i data-r="loadBar"></i></div>
      <div class="gp-loading__sub" data-r="loadSub"></div>
      <button type="button" class="gp-link" data-r="loadCancel">Cancel</button>
    </div>
  </div>

  <div class="gp-error" data-r="error">
    <div class="gp-error__card">
      <div class="gp-error__icon">${ICON.alert}</div>
      <p data-r="errorText"></p>
      <button type="button" class="gp-btn gp-btn--primary" data-r="errorRetry">Choose another file</button>
    </div>
  </div>

  <div class="gp-drop" data-r="drop"><span>Drop to load</span></div>
  <input type="file" data-r="fileInput" hidden accept="video/*,.mkv,.mp4,.m4v,.webm,.mov,.avi,.ts">
  <input type="file" data-r="subInput" hidden accept=".srt,.vtt,.ass,.ssa,.sub,.txt,text/vtt,text/plain">
</div>`;

      const root = this.container.querySelector('.gp');
      this.$ = { root, video: root.querySelector('video') };
      root.querySelectorAll('[data-r]').forEach((n) => { this.$[n.dataset.r] = n; });
      if (!this.opts.allowLocalFile) this.$.btnPickVideo.hidden = true;
      if (!this.opts.allowLocalSubtitle) this.$.btnPickSub.hidden = true;
    }

    _on(target, ev, fn, opts) {
      target.addEventListener(ev, fn, opts);
      this._cleanups.push(() => target.removeEventListener(ev, fn, opts));
    }

    /* -------------------------------------------------------------
       Event wiring
    ------------------------------------------------------------- */
    _bind() {
      const $ = this.$, v = $.video;

      // Buttons
      this._on($.btnPlay, 'click', () => this.togglePlay());
      this._on($.bigplay, 'click', () => this.togglePlay());
      this._on($.btnBack, 'click', () => this._seekBtn(-1));
      this._on($.btnFwd, 'click', () => this._seekBtn(1));
      this._on($.btnMute, 'click', () => this.toggleMute());
      this._on($.btnFs, 'click', () => this.toggleFullscreen());
      this._on($.btnSubs, 'click', () => this.openSheet('subs'));
      this._on($.vol, 'input', () => { v.muted = false; v.volume = +$.vol.value; });
      this._on($.btnPickVideo, 'click', () => $.fileInput.click());
      this._on($.errorRetry, 'click', () => $.fileInput.click());
      this._on($.loadCancel, 'click', () => this._cancelLoad());
      this._on($.fileInput, 'change', () => { const f = $.fileInput.files[0]; $.fileInput.value = ''; if (f) this.loadLocalVideoFile(f); });
      this._on($.subInput, 'change', () => { const f = $.subInput.files[0]; $.subInput.value = ''; if (f) this.loadLocalSubtitleFile(f); });

      // Video element
      this._on(v, 'play', () => { this._onPlayState(); this._startLoop(); });
      this._on(v, 'pause', () => this._onPlayState());
      this._on(v, 'ended', () => { this._onPlayState(); this._showControls(); });
      this._on(v, 'timeupdate', () => { this._updateTime(); if (v.paused) this._updateSubtitle(); });
      this._on(v, 'seeking', () => { $.root.classList.add('gp--busy'); });
      this._on(v, 'seeked', () => { $.root.classList.remove('gp--busy'); this._updateTime(); this._updateSubtitle(); });
      this._on(v, 'waiting', () => $.root.classList.add('gp--busy'));
      this._on(v, 'playing', () => $.root.classList.remove('gp--busy'));
      this._on(v, 'canplay', () => $.root.classList.remove('gp--busy'));
      this._on(v, 'durationchange', () => this._updateTime());
      this._on(v, 'progress', () => this._updateBuffered());
      this._on(v, 'volumechange', () => { this._syncVolumeUI(); LS.set('volume', v.volume); });
      this._on(v, 'error', () => {
        if (this.$.root.dataset.state === 'ready' && v.error) this._fail('Playback stopped: ' + (v.error.message || 'the file could not be decoded') + '.');
      });

      // Seek bar
      let scrubbing = false;
      this._on($.seek, 'input', () => {
        scrubbing = true;
        const d = v.duration || 0;
        $.time.textContent = `${fmtTime(($.seek.value / 1000) * d)} / ${fmtTime(d)}`;
        this._paintSeek($.seek.value / 1000);
      });
      this._on($.seek, 'change', () => {
        scrubbing = false;
        if (v.duration) v.currentTime = ($.seek.value / 1000) * v.duration;
      });
      this._scrubbing = () => scrubbing;
      this._on($.seekWrap, 'pointermove', (e) => {
        const r = $.seekWrap.getBoundingClientRect();
        const p = clamp((e.clientX - r.left) / r.width, 0, 1);
        $.seekTip.textContent = fmtTime(p * (v.duration || 0));
        $.seekTip.style.left = `${clamp(p * r.width, 24, r.width - 24)}px`;
      });

      // Controls visibility
      this._on($.root, 'pointermove', (e) => { if (e.pointerType === 'mouse') this._showControls(); });
      this._on($.root, 'pointerleave', () => this._scheduleHide(600));
      this._on($.controls, 'pointerenter', () => { this._overControls = true; });
      this._on($.controls, 'pointerleave', () => { this._overControls = false; this._scheduleHide(); });
      this._on($.root, 'focusin', () => this._showControls());

      this._bindZones();
      this._bindSheet();
      this._bindDrop();

      // Keyboard
      this._on(document, 'keydown', (e) => this._onKey(e));

      // Fullscreen
      const fsChange = () => this._onFullscreenChange();
      this._on(document, 'fullscreenchange', fsChange);
      this._on(document, 'webkitfullscreenchange', fsChange);

      // Wake lock follows playback; re-acquire when the tab comes back
      this._on(document, 'visibilitychange', () => { if (document.visibilityState === 'visible' && !v.paused) this._wake(true); });

      // Subtitle font scales with the player height
      if (global.ResizeObserver) {
        this._ro = new ResizeObserver(() => {
          const h = $.root.clientHeight || 360;
          $.root.style.setProperty('--gp-base', clamp(h * 0.042, 13, 46).toFixed(1) + 'px');
        });
        this._ro.observe($.root);
      }
    }

    /* -------------------------------------------------------------
       Tap / swipe gestures
         tap          touch: show/hide controls   mouse: play/pause
         double tap   left/right: -10 / +10 s (keep tapping to add more)
                      centre: touch = play/pause, mouse = fullscreen
         swipe up/down  left edge = brightness, right edge = volume (touch)
    ------------------------------------------------------------- */
    _zoneOf(x) {
      const r = this.$.zones.getBoundingClientRect();
      const p = (x - r.left) / r.width;
      return p < 0.35 ? 'left' : p > 0.65 ? 'right' : 'center';
    }

    _bindZones() {
      const z = this.$.zones, v = this.$.video;
      let g = null;

      this._on(z, 'contextmenu', (e) => e.preventDefault());
      this._on(z, 'pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        g = { id: e.pointerId, x: e.clientX, y: e.clientY, type: e.pointerType, zone: this._zoneOf(e.clientX), mode: null, moved: false,
              b0: this.state.brightness, v0: v.volume };
        try { z.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      });
      this._on(z, 'pointermove', (e) => {
        if (!g || g.id !== e.pointerId) return;
        const dx = e.clientX - g.x, dy = e.clientY - g.y;
        if (Math.hypot(dx, dy) > 10) g.moved = true;
        if (g.type === 'mouse') return;
        if (!g.mode && g.zone !== 'center' && Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx) * 1.4) g.mode = g.zone === 'left' ? 'brightness' : 'volume';
        if (!g.mode) return;
        const h = z.getBoundingClientRect().height;
        const delta = (-dy / (h * 0.65));
        if (g.mode === 'brightness') this._setBrightness(g.b0 + delta);
        else { v.muted = false; v.volume = clamp(g.v0 + delta, 0, 1); this._flashMeter('V'); }
      });
      const end = (e) => {
        if (!g || g.id !== e.pointerId) return;
        const gg = g; g = null;
        if (e.type === 'pointercancel') return;
        if (!gg.mode && !gg.moved) this._onTap(gg.zone, gg.type);
      };
      this._on(z, 'pointerup', end);
      this._on(z, 'pointercancel', end);
    }

    _onTap(zone, type) {
      if (this.$.root.dataset.state !== 'ready') return;
      const now = performance.now();
      const side = zone === 'left' ? -1 : zone === 'right' ? 1 : 0;

      // keep tapping after a double tap: every tap adds another 10 s
      if (side && this._chain && this._chain.side === side && now - this._chain.t < 650) {
        this._chainSeek(side);
        return;
      }
      if (this._lastTap && this._lastTap.zone === zone && now - this._lastTap.t < 300) {
        clearTimeout(this._tapTimer); this._lastTap = null;
        if (side) { this._chain = { side, total: 0, t: now }; this._chainSeek(side); }
        else if (type === 'mouse') this.toggleFullscreen();
        else this.togglePlay();
        return;
      }
      this._lastTap = { zone, t: now };
      clearTimeout(this._tapTimer);
      this._tapTimer = setTimeout(() => {
        this._lastTap = null;
        if (type === 'mouse') this.togglePlay();
        else this._toggleControls();
      }, 300);
    }

    _chainSeek(side) {
      const c = this._chain, s = this.opts.seekSeconds;
      c.total += s; c.t = performance.now();
      this.seekBy(side * s);
      const el = side < 0 ? this.$.rippleL : this.$.rippleR;
      const txt = side < 0 ? this.$.rippleLText : this.$.rippleRText;
      txt.textContent = `${c.total} seconds`;
      el.classList.remove('on'); void el.offsetWidth; el.classList.add('on');
      clearTimeout(c.timer);
      c.timer = setTimeout(() => { el.classList.remove('on'); if (this._chain === c) this._chain = null; }, 700);
    }

    _setBrightness(b) {
      b = clamp(b, 0.15, 1);
      this.state.brightness = b;
      this.$.dim.style.opacity = String(1 - b);
      this._flashMeter('B');
    }

    _flashMeter(which) {
      const v = this.$.video;
      const el = which === 'B' ? this.$.meterB : this.$.meterV;
      const fill = which === 'B' ? this.$.meterBFill : this.$.meterVFill;
      fill.style.height = `${Math.round((which === 'B' ? (this.state.brightness - 0.15) / 0.85 : (v.muted ? 0 : v.volume)) * 100)}%`;
      el.classList.add('on');
      clearTimeout(el._t);
      el._t = setTimeout(() => el.classList.remove('on'), 900);
    }

    /* -------------------------------------------------------------
       Subtitle sheet
    ------------------------------------------------------------- */
    _bindSheet() {
      const $ = this.$;
      this._on($.sheetClose, 'click', () => this.closeSheet());
      this._on($.backdrop, 'pointerdown', () => this.closeSheet());
      this._on($.tabs, 'click', (e) => { const b = e.target.closest('[data-tab]'); if (b) this._setTab(b.dataset.tab); });

      this._on($.btnPickSub, 'click', () => $.subInput.click());
      this._on($.subToggle, 'change', () => this.setSubtitlesOn($.subToggle.checked));
      this._on($.encSel, 'change', () => this._reDecode($.encSel.value));

      // Offset stepper
      this._bindHold($.offMinus, -1);
      this._bindHold($.offPlus, +1);
      this._on($.offReset, 'click', () => this.setSubtitleOffset(0, { emit: true }));
      this._on($.offInput, 'focus', () => $.offInput.select());
      this._on($.offInput, 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $.offInput.blur(); } e.stopPropagation(); });
      this._on($.offInput, 'change', () => {
        const n = parseFloat($.offInput.value.replace(',', '.'));
        if (isFinite(n)) this.setSubtitleOffset(n, { emit: true });
        else this._renderOffset();
      });
      this._on($.offInput, 'blur', () => this._renderOffset());

      // Appearance
      const st = this.state.style;
      const upd = () => { LS.set('substyle', this.state.style); this._applyStyle(); };
      this._on($.stSize, 'input', () => { st.size = +$.stSize.value; upd(); });
      this._on($.stOpacity, 'input', () => { st.opacity = +$.stOpacity.value; upd(); });
      this._on($.stBg, 'input', () => { st.bg = +$.stBg.value; upd(); });
      this._on($.stColor, 'input', () => { st.color = $.stColor.value; upd(); });
      this._on($.swatches, 'click', (e) => { const b = e.target.closest('[data-color]'); if (b) { st.color = b.dataset.color; upd(); } });
      this._on($.stReset, 'click', () => { Object.assign(this.state.style, DEFAULT_STYLE); upd(); });
    }

    /* Hold-to-repeat with acceleration: 0.5 s steps, then 1, 2 and 5 s as you keep holding. */
    _bindHold(btn, dir) {
      let t0 = 0, timer = null, holding = false;
      const tick = () => {
        const el = performance.now() - t0;
        const amt = el < 1200 ? 0.5 : el < 2600 ? 1 : el < 4200 ? 2 : 5;
        this.nudgeOffset(dir * amt);
        timer = setTimeout(tick, el < 1200 ? 150 : el < 2600 ? 110 : 80);
      };
      const stop = () => { holding = false; clearTimeout(timer); timer = null; };
      this._on(btn, 'pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.preventDefault();
        holding = true; t0 = performance.now();
        try { btn.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        this.nudgeOffset(dir * 0.5);
        timer = setTimeout(tick, 420);
      });
      ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => this._on(btn, ev, () => { if (holding) stop(); }));
      this._on(btn, 'keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); this.nudgeOffset(dir * 0.5); }
      });
      this._on(btn, 'contextmenu', (e) => e.preventDefault());
      this._cleanups.push(stop);
    }

    openSheet(tab) {
      if (this.$.root.dataset.state !== 'ready') return;
      this._setTab(tab || this.state.sheetTab);
      // On phones the sheet starts below the picture so subtitles stay visible while you tune them
      this.$.root.style.setProperty('--gp-sheet-top', `${Math.round(this.$.root.getBoundingClientRect().bottom)}px`);
      this.$.root.classList.add('gp--sheet');
      this.$.sheet.setAttribute('aria-hidden', 'false');
      this._showControls();
    }

    closeSheet() {
      this.$.root.classList.remove('gp--sheet');
      this.$.sheet.setAttribute('aria-hidden', 'true');
      this._scheduleHide();
    }

    get sheetOpen() { return this.$.root.classList.contains('gp--sheet'); }

    _setTab(name) {
      const $ = this.$;
      if (name === 'audio' && $.tabAudio.hidden) name = 'subs';
      if (name === 'quality' && $.tabQuality.hidden) name = 'subs';
      this.state.sheetTab = name;
      $.root.querySelectorAll('.gp-tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
      $.root.querySelectorAll('.gp-panel').forEach((p) => { p.hidden = p.dataset.panel !== name; });
    }

    /* -------------------------------------------------------------
       Drag & drop
    ------------------------------------------------------------- */
    _bindDrop() {
      const r = this.$.root;
      let depth = 0;
      const isFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf('Files') >= 0;
      this._on(r, 'dragenter', (e) => { if (isFiles(e)) { e.preventDefault(); depth++; r.classList.add('gp--drop'); } });
      this._on(r, 'dragover', (e) => { if (isFiles(e)) e.preventDefault(); });
      this._on(r, 'dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) r.classList.remove('gp--drop'); });
      this._on(r, 'drop', (e) => {
        if (!isFiles(e)) return;
        e.preventDefault(); depth = 0; r.classList.remove('gp--drop');
        const f = e.dataTransfer.files[0];
        if (!f) return;
        if (/\.(srt|vtt|ass|ssa|sub|txt)$/i.test(f.name)) this.loadLocalSubtitleFile(f);
        else if (this.opts.allowLocalFile) this.loadLocalVideoFile(f);
      });
    }

    /* -------------------------------------------------------------
       Keyboard
    ------------------------------------------------------------- */
    _onKey(e) {
      if (!this._alive || !this.container.isConnected) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      const tag = t && t.tagName;
      if (tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && t.type !== 'range' && t.type !== 'checkbox') || (t && t.isContentEditable)) return;
      if ((e.key === ' ' || e.key === 'Enter') && (tag === 'BUTTON' || tag === 'A' || tag === 'LABEL' || (tag === 'INPUT' && t.type === 'checkbox'))) return;
      if (e.key === 'Escape') {
        if (this.sheetOpen) { this.closeSheet(); e.preventDefault(); }
        else if (this._pseudoFs) this.toggleFullscreen();
        return;
      }
      if (this.$.root.dataset.state !== 'ready') return;

      const v = this.$.video, s = this.opts.seekSeconds;
      let handled = true;
      switch (e.key) {
        case ' ': case 'k': case 'K': this.togglePlay(); break;
        case 'ArrowLeft': case 'j': case 'J': this.seekBy(-s); this.hud(`-${s} s`); break;
        case 'ArrowRight': case 'l': case 'L': this.seekBy(s); this.hud(`+${s} s`); break;
        case 'ArrowUp': v.muted = false; v.volume = clamp(v.volume + 0.05, 0, 1); this.hud(`Volume ${Math.round(v.volume * 100)}%`); break;
        case 'ArrowDown': v.volume = clamp(v.volume - 0.05, 0, 1); this.hud(`Volume ${Math.round(v.volume * 100)}%`); break;
        case 'm': case 'M': this.toggleMute(); this.hud(v.muted ? 'Muted' : 'Sound on'); break;
        case 'f': case 'F': this.toggleFullscreen(); break;
        case 'c': case 'C': this.setSubtitlesOn(!this.state.subtitlesOn); this.hud(this.state.subtitlesOn ? 'Subtitles on' : 'Subtitles off'); break;
        case 's': case 'S': this.sheetOpen ? this.closeSheet() : this.openSheet('subs'); break;
        case '[': this.nudgeOffset(-0.5); break;
        case ']': this.nudgeOffset(0.5); break;
        case ',': if (v.paused) { v.currentTime = Math.max(0, v.currentTime - 1 / 24); } else handled = false; break;
        case '.': if (v.paused) { v.currentTime = v.currentTime + 1 / 24; } else handled = false; break;
        case 'Home': v.currentTime = 0; break;
        case 'End': if (v.duration) v.currentTime = Math.max(0, v.duration - 1); break;
        default:
          if (/^[0-9]$/.test(e.key) && v.duration) v.currentTime = v.duration * (+e.key / 10);
          else handled = false;
      }
      if (handled) { e.preventDefault(); this._showControls(); }
    }

    /* -------------------------------------------------------------
       Playback controls
    ------------------------------------------------------------- */
    togglePlay() {
      const v = this.$.video;
      if (this.$.root.dataset.state !== 'ready') return;
      if (v.paused || v.ended) {
        const p = v.play();
        if (p && p.catch) p.catch(() => { /* autoplay blocked: user can press play again */ });
        this._pulse('play');
      } else {
        v.pause();
        this._pulse('pause');
      }
    }

    toggleMute() { const v = this.$.video; v.muted = !v.muted; this._syncVolumeUI(); }

    seekBy(sec) {
      const v = this.$.video;
      if (!v.duration) return;
      v.currentTime = clamp(v.currentTime + sec, 0, v.duration);
    }

    _seekBtn(side) {
      this.seekBy(side * this.opts.seekSeconds);
      this.hud(`${side < 0 ? '-' : '+'}${this.opts.seekSeconds} s`);
    }

    _pulse(kind) {
      const p = this.$.pulse;
      p.innerHTML = kind === 'play' ? ICON.play : ICON.pause;
      p.classList.remove('on'); void p.offsetWidth; p.classList.add('on');
    }

    hud(msg, ms) {
      const h = this.$.hud;
      h.textContent = msg;
      h.classList.add('on');
      clearTimeout(this._hudT);
      this._hudT = setTimeout(() => h.classList.remove('on'), ms || 1100);
    }

    _onPlayState() {
      const v = this.$.video;
      const playing = !v.paused && !v.ended;
      this.$.root.classList.toggle('gp--playing', playing);
      const icon = v.ended ? ICON.replay : playing ? ICON.pause : ICON.play;
      this.$.btnPlay.innerHTML = icon;
      this.$.bigplay.innerHTML = icon;
      this.$.btnPlay.setAttribute('aria-label', playing ? 'Pause (K)' : 'Play (K)');
      this.$.bigplay.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      if (playing) { this._scheduleHide(); this._wake(true); } else { this._showControls(); this._wake(false); }
    }

    _syncVolumeUI() {
      const v = this.$.video;
      this.$.vol.value = v.muted ? 0 : v.volume;
      this.$.btnMute.innerHTML = (v.muted || v.volume === 0) ? ICON.mute : v.volume < 0.5 ? ICON.volLow : ICON.vol;
      this.$.vol.style.setProperty('--p', `${(v.muted ? 0 : v.volume) * 100}%`);
    }

    _updateTime() {
      const v = this.$.video, d = v.duration || 0;
      if (!this._scrubbing()) {
        this.$.time.textContent = `${fmtTime(v.currentTime)} / ${fmtTime(d)}`;
        const p = d ? v.currentTime / d : 0;
        this.$.seek.value = Math.round(p * 1000);
        this._paintSeek(p);
      }
    }

    _paintSeek(p) { this.$.seek.style.setProperty('--p', `${(p * 100).toFixed(2)}%`); }

    _updateBuffered() {
      const v = this.$.video;
      if (!v.duration || !v.buffered.length) return;
      let end = 0;
      for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime + 0.5) end = Math.max(end, v.buffered.end(i));
      this.$.seek.style.setProperty('--b', `${(end / v.duration * 100).toFixed(2)}%`);
    }

    /* -------------------------------------------------------------
       Controls visibility / fullscreen / wake lock
    ------------------------------------------------------------- */
    _showControls() {
      this.$.root.classList.remove('gp--idle');
      this.state.controlsVisible = true;
      this._scheduleHide();
    }

    _toggleControls() {
      if (this.$.root.classList.contains('gp--idle') || !this.state.controlsVisible) this._showControls();
      else this._hideControls(true);
    }

    _hideControls(force) {
      const v = this.$.video;
      if (!force && (v.paused || this.sheetOpen || this._overControls || this._scrubbing())) return;
      if (this.sheetOpen) return;
      this.$.root.classList.add('gp--idle');
      this.state.controlsVisible = false;
    }

    _scheduleHide(delay) {
      clearTimeout(this._hideT);
      this._hideT = setTimeout(() => this._hideControls(false), delay || 3200);
    }

    toggleFullscreen() {
      const r = this.$.root;
      const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
      if (fsEl || this._pseudoFs) {
        if (fsEl) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); }
        if (this._pseudoFs) this._setPseudoFs(false);
        return;
      }
      const req = r.requestFullscreen || r.webkitRequestFullscreen;
      if (req) {
        const res = req.call(r, { navigationUI: 'hide' });
        if (res && res.catch) res.catch(() => this._setPseudoFs(true));
      } else {
        this._setPseudoFs(true);      // iPhone Safari cannot fullscreen arbitrary elements
      }
    }

    _setPseudoFs(on) {
      this._pseudoFs = on;
      this.$.root.classList.toggle('gp--pseudo', on);
      document.documentElement.classList.toggle('gp-lock', on);
      this._onFullscreenChange();
    }

    _onFullscreenChange() {
      const fs = !!(document.fullscreenElement || document.webkitFullscreenElement) || !!this._pseudoFs;
      this.$.root.classList.toggle('gp--fs', fs);
      this.$.btnFs.innerHTML = fs ? ICON.fsExit : ICON.fs;
      try {
        if (screen.orientation && screen.orientation.lock) {
          if (fs && this.$.video.videoWidth > this.$.video.videoHeight && /Mobi|Android/i.test(navigator.userAgent)) screen.orientation.lock('landscape').catch(() => {});
          else if (!fs && screen.orientation.unlock) screen.orientation.unlock();
        }
      } catch (e) { /* not supported */ }
    }

    async _wake(on) {
      try {
        if (on && navigator.wakeLock && !this._wl) {
          this._wl = await navigator.wakeLock.request('screen');
          this._wl.addEventListener('release', () => { this._wl = null; });
        } else if (!on && this._wl) {
          await this._wl.release(); this._wl = null;
        }
      } catch (e) { /* denied or unsupported */ }
    }

    /* -------------------------------------------------------------
       Subtitles
    ------------------------------------------------------------- */
    getSubtitle() {
      return this.sub.cues.length ? { name: this.sub.name, text: this.sub.text, source: this.sub.source } : null;
    }

    getSubtitleOffset() { return this.state.subtitleOffset; }

    async loadLocalSubtitleFile(file) {
      if (file.size > 5e6) { this.hud('That subtitle file is too large'); return false; }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const dec = decodeBytes(bytes, 'auto');
      return this.loadSubtitleText(dec.text, { name: file.name, source: 'local', bytes, encoding: dec.encoding });
    }

    loadSubtitleText(text, o) {
      o = o || {};
      const cues = parseSubtitles(text);
      if (!cues.length) { this.hud('No subtitles found in that file', 2200); return false; }
      this.sub = { cues, name: o.name || 'Subtitles', text, source: o.source || 'local', bytes: o.bytes || null, encoding: o.encoding || null };
      this.state.subtitlesOn = true;
      this.$.subToggle.checked = true;
      this._subKey = null;
      this._renderSubInfo();
      this._renderSheetState();
      this._updateSubtitle();
      if (this.sub.source === 'local') this._emit('subtitleload', { name: this.sub.name, text });
      return true;
    }

    clearSubtitles() {
      this.sub = { cues: [], name: '', text: '', source: 'local', bytes: null, encoding: null };
      this._subKey = null;
      this._renderSubInfo(); this._renderSheetState(); this._updateSubtitle();
    }

    _reDecode(enc) {
      if (!this.sub.bytes) return;
      const dec = decodeBytes(this.sub.bytes, enc);
      this.loadSubtitleText(dec.text, { name: this.sub.name, source: 'local', bytes: this.sub.bytes, encoding: enc === 'auto' ? dec.encoding : enc });
      this.$.encSel.value = enc;
    }

    async _loadSubtitleUrl(url) {
      try {
        const res = await fetch(url);
        const bytes = new Uint8Array(await res.arrayBuffer());
        const dec = decodeBytes(bytes, 'auto');
        this.loadSubtitleText(dec.text, { name: url.split('/').pop(), source: 'remote', bytes, encoding: dec.encoding });
      } catch (e) { /* ignore */ }
    }

    setSubtitlesOn(on) {
      this.state.subtitlesOn = !!on;
      this.$.subToggle.checked = !!on;
      this._subKey = null;
      this._updateSubtitle();
      this._renderSheetState();
    }

    _startLoop() {
      if (this._raf) return;
      const v = this.$.video;
      const loop = () => {
        this._raf = null;
        this._updateSubtitle();
        if (!v.paused && !v.ended && this._alive) this._raf = requestAnimationFrame(loop);
      };
      this._raf = requestAnimationFrame(loop);
    }

    _updateSubtitle() {
      const st = this.$.subText;
      const cues = this.sub.cues;
      let active = [];
      if (this.state.subtitlesOn && cues.length) active = cuesAt(cues, this.$.video.currentTime - this.state.subtitleOffset);
      const key = active.map((c) => c.i).join(',');
      if (key === this._subKey) return;
      this._subKey = key;
      st.textContent = '';
      st.classList.toggle('has-text', active.length > 0);
      active.forEach((c) => {
        const line = document.createElement('div');
        line.className = 'gp-sub__line';
        renderCueInto(line, c.text);
        st.appendChild(line);
      });
    }

    /* Offset: positive = subtitles appear later, negative = earlier. */
    setSubtitleOffset(v, o) {
      v = clamp(Math.round(v * 10) / 10, -3600, 3600);
      const changed = v !== this.state.subtitleOffset;
      this.state.subtitleOffset = v;
      this._renderOffset();
      this._subKey = null;
      this._updateSubtitle();
      if (changed && o && o.emit) this._emit('subtitleoffsetchange', v);
    }

    nudgeOffset(delta) {
      this.setSubtitleOffset(this.state.subtitleOffset + delta, { emit: true });
      if (!this.sheetOpen) this.hud(`Subtitle timing ${(this.state.subtitleOffset > 0 ? '+' : '') + this.state.subtitleOffset.toFixed(1)} s`);
    }

    _renderOffset() {
      const o = this.state.subtitleOffset;
      const $ = this.$;
      if (document.activeElement !== $.offInput) $.offInput.value = (o > 0 ? '+' : '') + o.toFixed(1);
      const a = Math.abs(o);
      const txt = a >= 60 ? `${Math.floor(a / 60)} min ${(a % 60).toFixed(1).replace(/\.0$/, '')} s` : `${a.toFixed(1).replace(/\.0$/, '')} s`;
      $.offNote.textContent = o === 0 ? 'No shift: subtitles follow the video exactly'
        : o > 0 ? `Subtitles appear ${txt} later` : `Subtitles appear ${txt} earlier`;
      $.offInput.classList.toggle('is-shifted', o !== 0);
    }

    _applyStyle() {
      const s = this.state.style, r = this.$.root;
      const hex = /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : '#ffffff';
      const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(',');
      r.style.setProperty('--gp-sub-scale', (s.size / 100).toString());
      r.style.setProperty('--gp-sub-color', `rgba(${rgb},${s.opacity / 100})`);
      r.style.setProperty('--gp-sub-bg', `rgba(0,0,0,${(s.bg / 100) * 0.85})`);
      r.style.setProperty('--gp-sub-shadow', `${Math.min(1, s.opacity / 100)}`);
      this.$.stSize.value = s.size; this.$.stSizeOut.textContent = `${s.size}%`;
      this.$.stOpacity.value = s.opacity; this.$.stOpacityOut.textContent = `${s.opacity}%`;
      this.$.stBg.value = s.bg; this.$.stBgOut.textContent = `${s.bg}%`;
      this.$.stColor.value = hex;
      this.$.swatches.querySelectorAll('[data-color]').forEach((b) => b.classList.toggle('is-on', b.dataset.color.toLowerCase() === hex.toLowerCase()));
    }

    _renderSubInfo() {
      const s = this.sub, $ = this.$;
      if (!s.cues.length) {
        $.subInfo.textContent = 'No subtitles yet. Supports SRT, VTT and ASS. Your friend gets the file automatically.';
      } else {
        $.subInfo.textContent = '';
        const strong = document.createElement('strong');
        strong.textContent = s.name;
        $.subInfo.appendChild(strong);
        $.subInfo.appendChild(document.createTextNode(` - ${s.cues.length} ${s.cues.length === 1 ? 'line' : 'lines'}${s.source === 'remote' ? ', shared by your friend' : ''}`));
      }
      $.encWrap.hidden = !(s.bytes && s.cues.length);
      if (s.bytes) $.encSel.value = ENCODINGS.some((e) => e[0] === s.encoding) ? s.encoding : 'auto';
    }

    _renderSheetState() {
      this.$.subDot.classList.toggle('on', this.sub.cues.length > 0 && this.state.subtitlesOn);
      this._renderSubInfo();
    }

    /* -------------------------------------------------------------
       Video loading
    ------------------------------------------------------------- */
    _emit(name, detail) { this.container.dispatchEvent(new CustomEvent(name, { detail })); }

    setTitle(t) { this.$.title.textContent = t || ''; this.$.top.classList.toggle('has-title', !!t); }

    _setState(s) { this.$.root.dataset.state = s; if (s !== 'ready') this.closeSheet(); }

    _loading(title, p, cancellable) {
      const $ = this.$;
      this._setState('loading');
      $.loadTitle.textContent = title;
      $.loadBar.parentNode.classList.toggle('is-indeterminate', p == null);
      $.loadBar.style.width = p == null ? '' : `${Math.round(clamp(p, 0, 1) * 100)}%`;
      $.loadSub.textContent = p == null ? '' : `${Math.round(clamp(p, 0, 1) * 100)}%`;
      $.loadCancel.hidden = !cancellable;
    }

    _fail(msg) {
      this._swapLock = false;
      this._setState('error');
      this.$.errorText.textContent = msg;
      this._emit('videoerror', { message: msg });
    }

    _cancelLoad() {
      this._token++;
      if (this._abort) { try { this._abort.abort(); } catch (e) { /* ignore */ } }
      this._abort = null;
      this._swapLock = false;
      this._setState(this._url ? 'ready' : 'empty');
    }

    _revokeUrl() {
      if (this._url) { try { URL.revokeObjectURL(this._url); } catch (e) { /* ignore */ } this._url = null; }
    }

    _attach(url, token) {
      const v = this.$.video;
      return new Promise((resolve) => {
        let done = false, timer = null;
        const finish = (ok, err) => {
          if (done) return; done = true; clearTimeout(timer);
          v.removeEventListener('loadedmetadata', onMeta); v.removeEventListener('error', onErr);
          resolve({ ok, err });
        };
        const onMeta = () => finish(v.videoWidth > 0 || v.videoHeight > 0, 'no-video');    // audio-only result = video codec unsupported
        const onErr = () => finish(false, v.error);
        v.addEventListener('loadedmetadata', onMeta);
        v.addEventListener('error', onErr);
        timer = setTimeout(() => finish(false, 'timeout'), 25000);
        this._revokeUrl();
        this._url = url;
        v.src = url;
        v.load();
      });
    }

    _resetMedia() {
      const v = this.$.video;
      if (this._abort) { try { this._abort.abort(); } catch (e) { /* ignore */ } this._abort = null; }
      if (this._hls) { try { this._hls.destroy(); } catch (e) { /* ignore */ } this._hls = null; }
      v.pause();
      v.removeAttribute('src');
      v.load();
      this._revokeUrl();
    }

    async loadLocalVideoFile(file, resume) {
      const token = ++this._token;
      this._swapLock = true;
      if (!resume) {
        this._resetMedia();
        this._mkv = null; this._audioIndex = null;
        this._renderTracks();
        this.fileInfo = { name: file.name, size: file.size, duration: 0 };
        this.setTitle(file.name);
        this._emit('filechosen', { name: file.name, size: file.size });
      }
      this._file = file;
      this._loading('Opening file', null);

      const isMkv = /\.(mkv|mk3d|mka)$/i.test(file.name) || /matroska/i.test(file.type);
      if (!isMkv) {
        const r = await this._attach(URL.createObjectURL(file), token);
        if (token !== this._token) return;
        if (!r.ok) return this._fail('This browser can\u2019t play that file. MP4 (H.264) works everywhere; Chrome and Edge also handle most other formats.');
        return this._ready(token, null);
      }

      let info = this._mkv;
      if (!info && global.SnuggleMkv) {
        try { info = await global.SnuggleMkv.probe(file); } catch (e) { console.warn('[mkv] probe failed', e); }
        if (token !== this._token) return;
        this._mkv = info;
        this._audioIndex = info ? info.defaultAudio : 0;
        this._renderTracks();
      }
      return this._startMkv(file, info, token, resume);
    }

    async _startMkv(file, info, token, resume) {
      const M = global.SnuggleMkv;
      const audioIdx = this._audioIndex == null ? 0 : this._audioIndex;
      const plan = (M && info) ? M.plan(info, audioIdx) : { mode: 'try', audioMode: 'aac', videoName: '' };

      if (plan.mode === 'unsupported') {
        return this._fail(`Your browser can\u2019t decode this video (${plan.videoName}). Try Chrome or Edge on a recent device, or convert it to H.264.`);
      }

      // 1) Play the MKV as-is when the browser can (Chrome / Edge with AAC, MP3, Opus ... audio)
      const defaultTrack = info ? info.defaultAudio : 0;
      if ((plan.mode === 'native' || plan.mode === 'try') && audioIdx === defaultTrack) {
        const r = await this._attach(URL.createObjectURL(file), token);
        if (token !== this._token) return;
        if (r.ok) { this._via = 'direct'; return this._ready(token, resume); }
      }

      // 2) Fallback: remux to MP4 in the browser (video is copied, odd audio becomes AAC)
      if (!M) return this._fail('MKV support files are missing (js/mkv.js).');
      const ctl = new AbortController();
      this._abort = ctl;
      this._loading('Getting your MKV ready', 0, true);
      if (file.size > 1.8e9) this.hud('Large file: this may take a while and use a lot of memory', 3500);
      try {
        const out = await M.remux(file, {
          audioIndex: audioIdx, audioMode: plan.audioMode, hasAudio: info ? info.audio.length > 0 : true,
          signal: ctl.signal,
          onStatus: (msg, p) => { if (token === this._token) this._loading(msg, p, true); }
        });
        if (token !== this._token) return;
        this._abort = null;
        const r = await this._attach(URL.createObjectURL(out.blob), token);
        if (token !== this._token) return;
        if (!r.ok) return this._fail('The converted video still won\u2019t play in this browser.');
        this._via = 'remux';
        return this._ready(token, resume);
      } catch (e) {
        if (token !== this._token) return;
        if (ctl.signal.aborted) return;
        console.warn('[mkv] remux failed', e);
        const big = file.size > 1.5e9 ? ' The file is very large; Chrome or Edge can often play it without conversion.' : '';
        return this._fail(`Couldn\u2019t prepare this MKV (${(e && e.message) || String(e) || 'unknown error'}).${big}`);
      }
    }

    _ready(token, resume) {
      const v = this.$.video;
      this.fileInfo.duration = v.duration || 0;
      this._setState('ready');
      this._onPlayState();
      this._updateTime();
      this._updateSubtitle();
      this._showControls();
      const done = () => { setTimeout(() => { if (token === this._token) this._swapLock = false; }, 700); };
      if (resume) {
        v.currentTime = Math.min(resume.time, v.duration || resume.time);
        this.hud('Audio switched. Press play to continue', 2500);
      }
      this._emit('videoready', { name: this.fileInfo.name, size: this.fileInfo.size, duration: this.fileInfo.duration, resumed: !!resume });
      done();
    }

    /* Plain URLs / HLS (kept from v1 for pages that pass `src`) */
    async loadSource(src) {
      const token = ++this._token;
      this._swapLock = true;
      this._resetMedia();
      this._loading('Loading video', null);
      const v = this.$.video;
      let ok = false;
      if (/\.m3u8(\?|$)/i.test(src) && global.Hls && global.Hls.isSupported()) {
        const hls = new global.Hls();
        this._hls = hls;
        hls.loadSource(src); hls.attachMedia(v);
        ok = await new Promise((res) => { hls.on(global.Hls.Events.MANIFEST_PARSED, () => res(true)); hls.on(global.Hls.Events.ERROR, (e, d) => { if (d.fatal) res(false); }); });
        if (ok) this._renderQuality(hls.levels.map((l, i) => ({ label: l.height ? `${l.height}p` : `Level ${i + 1}`, i })), -1);
      } else {
        const r = await this._attach(src, token);
        this._url = null;                       // not a blob URL, nothing to revoke
        ok = r.ok;
      }
      if (token !== this._token) return;
      if (!ok) return this._fail('That video could not be loaded.');
      this.fileInfo = { name: src.split('/').pop(), size: 0, duration: v.duration || 0 };
      this._ready(token, null);
    }

    _renderQuality(levels, current) {
      const $ = this.$;
      $.tabQuality.hidden = levels.length < 2;
      $.qualityList.textContent = '';
      [{ label: 'Auto', i: -1 }].concat(levels).forEach((l) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'gp-opt'; b.textContent = l.label;
        b.setAttribute('aria-pressed', String(l.i === current));
        b.addEventListener('click', () => {
          if (this._hls) this._hls.currentLevel = l.i;
          $.qualityList.querySelectorAll('.gp-opt').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        });
        $.qualityList.appendChild(b);
      });
    }

    /* -------------------------------------------------------------
       MKV tracks (audio picker + embedded subtitles)
    ------------------------------------------------------------- */
    _renderTracks() {
      const $ = this.$, info = this._mkv, M = global.SnuggleMkv;
      $.embedList.textContent = '';
      $.audioList.textContent = '';
      const subs = info ? info.subtitles : [];
      $.embedWrap.hidden = subs.length === 0;
      const audio = info ? info.audio : [];
      $.tabAudio.hidden = audio.length < 2;

      subs.forEach((t) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'gp-opt';
        const name = M.describeTrack(t) || `Subtitle track ${t.index + 1}`;
        const main = document.createElement('span'); main.textContent = name;
        const meta = document.createElement('small'); meta.textContent = t.format || 'Image subtitles';
        b.appendChild(main); b.appendChild(meta);
        if (!t.format) { b.disabled = true; b.title = 'Picture-based subtitles can\u2019t be shown here'; }
        b.addEventListener('click', () => this._loadEmbedded(t, b, meta, name));
        $.embedList.appendChild(b);
      });

      audio.forEach((t) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'gp-opt';
        const name = M.describeTrack(t) || `Audio track ${t.index + 1}`;
        const main = document.createElement('span'); main.textContent = name;
        const meta = document.createElement('small'); meta.textContent = `${t.codecId.replace('A_', '')}${t.channels ? ' \u00b7 ' + t.channels + ' ch' : ''}`;
        b.appendChild(main); b.appendChild(meta);
        b.setAttribute('aria-pressed', String(t.index === this._audioIndex));
        b.addEventListener('click', () => this._pickAudio(t.index));
        $.audioList.appendChild(b);
      });
    }

    async _loadEmbedded(track, btn, meta, label) {
      const info = this._mkv, file = this._file;
      if (!info || !file || btn._busy) return;
      btn._busy = true;
      const orig = meta.textContent;
      try {
        const out = await global.SnuggleMkv.extractSubtitle(file, info, track, {
          onProgress: (p) => { meta.textContent = `Reading ${Math.round(p * 100)}%`; }
        });
        if (!out.cues.length) { this.hud('That subtitle track is empty', 2200); }
        else this.loadSubtitleText(out.srt, { name: label, source: 'local' });
      } catch (e) {
        console.warn('[mkv] subtitle extraction failed', e);
        this.hud('Couldn\u2019t read that subtitle track', 2500);
      }
      meta.textContent = orig;
      btn._busy = false;
    }

    _pickAudio(index) {
      if (index === this._audioIndex || !this._file) return;
      const v = this.$.video;
      const resume = { time: v.currentTime || 0 };
      this._audioIndex = index;
      this.$.audioList.querySelectorAll('.gp-opt').forEach((b, i) => b.setAttribute('aria-pressed', String(i === index)));
      this.closeSheet();
      this._swapLock = true;
      v.pause();
      this.loadLocalVideoFile(this._file, resume);
    }

    /* -------------------------------------------------------------
       Cleanup
    ------------------------------------------------------------- */
    destroy() {
      this._alive = false;
      this._cleanups.forEach((fn) => { try { fn(); } catch (e) { /* ignore */ } });
      this._cleanups = [];
      if (this._ro) this._ro.disconnect();
      clearTimeout(this._hideT); clearTimeout(this._tapTimer); clearTimeout(this._hudT);
      if (this._raf) cancelAnimationFrame(this._raf);
      this._wake(false);
      this._resetMedia();
      if (this._pseudoFs) this._setPseudoFs(false);
      this.container.innerHTML = '';
    }
  }

  GesturePlayer.utils = { decodeBytes, parseSubtitles, parseSrtVtt, parseAss, cuesAt, cleanCueText, fmtTime };
  global.GesturePlayer = GesturePlayer;
})(typeof window !== 'undefined' ? window : globalThis);
