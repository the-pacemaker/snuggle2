/*  mkv.js  -  Matroska (.mkv) support for the watch-together player
 *
 *  What it does
 *   1. probe(file)            reads the track list straight from the file header
 *                             (no big downloads) so we know the codecs up front.
 *   2. plan(info, audioIdx)   decides: play the file as-is, or remux it.
 *   3. extractSubtitle(...)   pulls an embedded text subtitle track out of the
 *                             file in plain JavaScript and returns SRT text.
 *   4. remux(...)             fallback for browsers that cannot open .mkv (Firefox,
 *                             Safari) or files with audio they cannot decode
 *                             (AC3 / DTS ...). Uses ffmpeg.wasm loaded on demand from
 *                             a CDN. Video is copied, never re-encoded; only
 *                             incompatible audio is converted to AAC.
 *
 *  Exposes window.SnuggleMkv
 */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------------ */
  /*  EBML primitives                                                    */
  /* ------------------------------------------------------------------ */
  var ID = {
    EBML: 0x1A45DFA3, DocType: 0x4282,
    Segment: 0x18538067, Info: 0x1549A966, Tracks: 0x1654AE6B, Cluster: 0x1F43B675,
    TimecodeScale: 0x2AD7B1, Duration: 0x4489, Title: 0x7BA9,
    TrackEntry: 0xAE, TrackNumber: 0xD7, TrackType: 0x83, FlagDefault: 0x88,
    CodecID: 0x86, Language: 0x22B59C, LanguageBCP47: 0x22B59D, Name: 0x536E,
    Video: 0xE0, PixelWidth: 0xB0, PixelHeight: 0xBA,
    Audio: 0xE1, Channels: 0x9F, SamplingFrequency: 0xB5,
    Timecode: 0xE7, SimpleBlock: 0xA3, BlockGroup: 0xA0, Block: 0xA1, BlockDuration: 0x9B
  };

  function readId(buf, pos) {
    var b = buf[pos];
    if (b === undefined) return null;
    var len = 1, mask = 0x80;
    while (len <= 4 && !(b & mask)) { len++; mask >>= 1; }
    if (len > 4 || pos + len > buf.length) return null;
    var id = 0;
    for (var i = 0; i < len; i++) id = id * 256 + buf[pos + i];
    return { id: id, len: len };
  }

  function readSize(buf, pos) {
    var b = buf[pos];
    if (b === undefined) return null;
    var len = 1, mask = 0x80;
    while (len <= 8 && !(b & mask)) { len++; mask >>= 1; }
    if (len > 8 || pos + len > buf.length) return null;
    var val = b & (mask - 1);
    var allOnes = val === mask - 1;
    for (var i = 1; i < len; i++) {
      var v = buf[pos + i];
      if (v !== 0xFF) allOnes = false;
      val = val * 256 + v;
    }
    return { size: allOnes ? -1 : val, len: len };
  }

  /* Iterate the children of an in-memory master element body. */
  function eachChild(buf, start, end, cb) {
    var pos = start;
    while (pos < end) {
      var id = readId(buf, pos);
      if (!id) return;
      var sz = readSize(buf, pos + id.len);
      if (!sz) return;
      var dataStart = pos + id.len + sz.len;
      var dataEnd = sz.size < 0 ? end : Math.min(end, dataStart + sz.size);
      if (cb(id.id, dataStart, dataEnd, sz.size) === false) return;
      pos = dataEnd;
    }
  }

  function uintAt(buf, s, e) { var v = 0; for (var i = s; i < e; i++) v = v * 256 + buf[i]; return v; }
  function strAt(buf, s, e) {
    var end = e; while (end > s && buf[end - 1] === 0) end--;
    return new TextDecoder('utf-8').decode(buf.subarray(s, end));
  }
  function floatAt(buf, s, e) {
    var dv = new DataView(buf.buffer, buf.byteOffset + s, e - s);
    return (e - s) === 4 ? dv.getFloat32(0) : (e - s) === 8 ? dv.getFloat64(0) : 0;
  }

  async function readBytes(file, start, end) {
    return new Uint8Array(await file.slice(start, end).arrayBuffer());
  }

  async function readHeader(file, pos) {
    var buf = await readBytes(file, pos, pos + 16);
    var id = readId(buf, 0);
    if (!id) return null;
    var sz = readSize(buf, id.len);
    if (!sz) return null;
    return { id: id.id, dataStart: pos + id.len + sz.len, size: sz.size };
  }

  /* ------------------------------------------------------------------ */
  /*  Codec tables                                                       */
  /* ------------------------------------------------------------------ */
  var VIDEO_CODECS = {
    'V_MPEG4/ISO/AVC':  { name: 'H.264', test: 'video/mp4; codecs="avc1.640028"' },
    'V_MPEGH/ISO/HEVC': { name: 'HEVC',  test: 'video/mp4; codecs="hvc1.1.6.L120.90"' },
    'V_VP9':            { name: 'VP9',   test: 'video/webm; codecs="vp09.00.10.08"' },
    'V_VP8':            { name: 'VP8',   test: 'video/webm; codecs="vp8"' },
    'V_AV1':            { name: 'AV1',   test: 'video/mp4; codecs="av01.0.08M.08"' }
  };

  /* mp4Copy: can this codec be stream-copied into an MP4 and still play in browsers */
  var AUDIO_CODECS = {
    'A_AAC':     { name: 'AAC',    test: 'audio/mp4; codecs="mp4a.40.2"', mp4Copy: true },
    'A_MPEG/L3': { name: 'MP3',    test: 'audio/mpeg',                    mp4Copy: true },
    'A_OPUS':    { name: 'Opus',   test: 'audio/webm; codecs="opus"',     mp4Copy: false },
    'A_VORBIS':  { name: 'Vorbis', test: 'audio/webm; codecs="vorbis"',   mp4Copy: false },
    'A_FLAC':    { name: 'FLAC',   test: 'audio/mp4; codecs="flac"',      mp4Copy: false },
    'A_AC3':     { name: 'Dolby Digital (AC3)', test: null, mp4Copy: false },
    'A_EAC3':    { name: 'Dolby Digital Plus',  test: null, mp4Copy: false },
    'A_DTS':     { name: 'DTS',    test: null, mp4Copy: false },
    'A_TRUEHD':  { name: 'TrueHD', test: null, mp4Copy: false }
  };

  var SUB_TEXT = {
    'S_TEXT/UTF8': 'SubRip', 'S_TEXT/ASS': 'ASS', 'S_TEXT/SSA': 'SSA', 'S_TEXT/WEBVTT': 'WebVTT'
  };

  function lookup(table, codecId) {
    if (table[codecId]) return table[codecId];
    for (var k in table) if (codecId.indexOf(k) === 0) return table[k];   // e.g. A_AAC/MPEG4/LC
    return null;
  }

  var _probeEl = null;
  function canPlay(type) {
    if (!type) return false;
    try {
      _probeEl = _probeEl || document.createElement('video');
      return _probeEl.canPlayType(type) !== '';
    } catch (e) { return false; }
  }

  /* ------------------------------------------------------------------ */
  /*  probe                                                              */
  /* ------------------------------------------------------------------ */
  function parseTrackEntry(buf, s, e) {
    var t = { number: 0, type: 'other', codecId: '', lang: 'und', name: '', isDefault: true,
              width: 0, height: 0, channels: 0 };
    eachChild(buf, s, e, function (id, ds, de) {
      switch (id) {
        case ID.TrackNumber: t.number = uintAt(buf, ds, de); break;
        case ID.TrackType: {
          var tt = uintAt(buf, ds, de);
          t.type = tt === 1 ? 'video' : tt === 2 ? 'audio' : tt === 17 ? 'subtitle' : 'other'; break;
        }
        case ID.FlagDefault: t.isDefault = uintAt(buf, ds, de) !== 0; break;
        case ID.CodecID: t.codecId = strAt(buf, ds, de); break;
        case ID.Language: if (t.lang === 'und') t.lang = strAt(buf, ds, de); break;
        case ID.LanguageBCP47: t.lang = strAt(buf, ds, de); break;
        case ID.Name: t.name = strAt(buf, ds, de); break;
        case ID.Video:
          eachChild(buf, ds, de, function (i2, a, b) {
            if (i2 === ID.PixelWidth) t.width = uintAt(buf, a, b);
            if (i2 === ID.PixelHeight) t.height = uintAt(buf, a, b);
          }); break;
        case ID.Audio:
          eachChild(buf, ds, de, function (i2, a, b) {
            if (i2 === ID.Channels) t.channels = uintAt(buf, a, b);
          }); break;
      }
    });
    return t;
  }

  async function probe(file) {
    var head = await readHeader(file, 0);
    if (!head || head.id !== ID.EBML) throw new Error('Not a Matroska file');

    var container = 'matroska';
    var hb = await readBytes(file, head.dataStart, head.dataStart + head.size);
    eachChild(hb, 0, hb.length, function (id, ds, de) {
      if (id === ID.DocType) container = strAt(hb, ds, de);
    });

    var seg = await readHeader(file, head.dataStart + head.size);
    if (!seg || seg.id !== ID.Segment) throw new Error('Segment not found');

    var info = { container: container, duration: 0, timecodeScale: 1000000, title: '',
                 tracks: [], segmentStart: seg.dataStart, segmentEnd: seg.size < 0 ? file.size : Math.min(file.size, seg.dataStart + seg.size) };

    var pos = seg.dataStart, guard = 0, haveTracks = false, haveInfo = false;
    while (pos < info.segmentEnd && guard++ < 200000) {
      var h = await readHeader(file, pos);
      if (!h) break;
      if (h.size < 0) break;                       // unknown-size child (live cluster): stop
      var end = h.dataStart + h.size;
      if (h.id === ID.Info) {
        var ib = await readBytes(file, h.dataStart, end);
        eachChild(ib, 0, ib.length, function (id, ds, de) {
          if (id === ID.TimecodeScale) info.timecodeScale = uintAt(ib, ds, de) || 1000000;
          else if (id === ID.Duration) info.duration = floatAt(ib, ds, de);
          else if (id === ID.Title) info.title = strAt(ib, ds, de);
        });
        haveInfo = true;
      } else if (h.id === ID.Tracks) {
        var tb = await readBytes(file, h.dataStart, end);
        eachChild(tb, 0, tb.length, function (id, ds, de) {
          if (id === ID.TrackEntry) info.tracks.push(parseTrackEntry(tb, ds, de));
        });
        haveTracks = true;
      }
      if (haveTracks && haveInfo) break;
      pos = end;
    }
    if (!haveTracks) throw new Error('No track list found');

    info.duration = info.duration * info.timecodeScale / 1e9;     // -> seconds
    info.video = info.tracks.filter(function (t) { return t.type === 'video'; });
    info.audio = info.tracks.filter(function (t) { return t.type === 'audio'; });
    info.subtitles = info.tracks.filter(function (t) { return t.type === 'subtitle'; });
    info.audio.forEach(function (t, i) { t.index = i; });
    info.subtitles.forEach(function (t, i) {
      t.index = i;
      t.format = SUB_TEXT[t.codecId] || null;       // null = picture subtitles (PGS / VobSub): not extractable
    });
    var d = 0;
    info.audio.forEach(function (t, i) { if (t.isDefault && !d) d = i; });
    info.defaultAudio = d;
    return info;
  }

  /* ------------------------------------------------------------------ */
  /*  plan: native playback or remux?                                    */
  /* ------------------------------------------------------------------ */
  function plan(info, audioIdx) {
    var v = info.video[0];
    var a = info.audio[audioIdx == null ? info.defaultAudio : audioIdx];
    var vc = v ? lookup(VIDEO_CODECS, v.codecId) : null;
    var ac = a ? lookup(AUDIO_CODECS, a.codecId) : null;

    var videoOk = !!(vc && canPlay(vc.test));
    var audioNative = !a || !!(ac && ac.test && canPlay(ac.test));
    var out = {
      videoOk: videoOk,
      videoName: vc ? vc.name : (v ? v.codecId : 'unknown'),
      audioName: ac ? ac.name : (a ? a.codecId : 'none'),
      // when remuxing: copy audio if mp4 can hold it, otherwise convert to AAC
      audioMode: (!a || (ac && ac.mp4Copy && audioNative)) ? 'copy' : 'aac'
    };
    if (!videoOk) { out.mode = 'unsupported'; return out; }
    out.mode = audioNative ? 'native' : 'remux';
    return out;
  }

  /* ------------------------------------------------------------------ */
  /*  Embedded subtitle extraction (pure JS)                             */
  /* ------------------------------------------------------------------ */
  function cleanAss(text) {
    return text
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\N/g, '\n').replace(/\\n/g, '\n').replace(/\\h/g, ' ')
      .replace(/\r/g, '').trim();
  }

  function payloadToText(codecId, bytes) {
    var raw = new TextDecoder('utf-8').decode(bytes);
    if (codecId === 'S_TEXT/ASS' || codecId === 'S_TEXT/SSA') {
      // ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text
      var idx = -1;
      for (var i = 0; i < 8; i++) { idx = raw.indexOf(',', idx + 1); if (idx < 0) return ''; }
      return cleanAss(raw.slice(idx + 1));
    }
    return raw.replace(/\r/g, '').trim();
  }

  function pad(n, w) { n = String(n); while (n.length < w) n = '0' + n; return n; }
  function srtTime(sec) {
    if (sec < 0) sec = 0;
    var ms = Math.round(sec * 1000);
    var h = Math.floor(ms / 3600000); ms -= h * 3600000;
    var m = Math.floor(ms / 60000); ms -= m * 60000;
    var s = Math.floor(ms / 1000); ms -= s * 1000;
    return pad(h, 2) + ':' + pad(m, 2) + ':' + pad(s, 2) + ',' + pad(ms, 3);
  }
  function cuesToSrt(cues) {
    return cues.map(function (c, i) {
      return (i + 1) + '\n' + srtTime(c.start) + ' --> ' + srtTime(c.end) + '\n' + c.text + '\n';
    }).join('\n');
  }

  /* Scan every cluster once and collect the blocks of one subtitle track. */
  async function extractSubtitle(file, info, track, opts) {
    opts = opts || {};
    if (!track.format) throw new Error('Picture-based subtitles (PGS/VobSub) cannot be shown');
    var scale = info.timecodeScale / 1e9;
    var cues = [];
    var pos = info.segmentStart;
    var guard = 0;

    while (pos < info.segmentEnd && guard++ < 500000) {
      if (opts.signal && opts.signal.aborted) throw new Error('Cancelled');
      var h = await readHeader(file, pos);
      if (!h) break;
      if (h.size < 0) throw new Error('Unsupported file layout (unknown-size cluster)');
      var end = Math.min(info.segmentEnd, h.dataStart + h.size);

      if (h.id === ID.Cluster) {
        var buf = await readBytes(file, h.dataStart, end);
        var clusterTime = 0;
        eachChild(buf, 0, buf.length, function (id, ds, de) {
          if (id === ID.Timecode) { clusterTime = uintAt(buf, ds, de); return; }
          var bs = -1, be = -1, dur = null;
          if (id === ID.SimpleBlock) { bs = ds; be = de; }
          else if (id === ID.BlockGroup) {
            eachChild(buf, ds, de, function (i2, a, b) {
              if (i2 === ID.Block) { bs = a; be = b; }
              else if (i2 === ID.BlockDuration) dur = uintAt(buf, a, b);
            });
          }
          if (bs < 0) return;
          var tn = readSize(buf, bs);                              // track number is a vint
          if (!tn || tn.size !== track.number) return;
          var hdr = bs + tn.len;
          var rel = (buf[hdr] << 8) | buf[hdr + 1];
          if (rel & 0x8000) rel -= 0x10000;
          var flags = buf[hdr + 2];
          if (flags & 0x06) return;                                // laced: not used for subtitles
          var text = payloadToText(track.codecId, buf.subarray(hdr + 3, be));
          if (!text) return;
          var start = (clusterTime + rel) * scale;
          cues.push({ start: start, end: dur != null ? start + dur * scale : null, text: text });
        });
        if (opts.onProgress) opts.onProgress(Math.min(1, (end - info.segmentStart) / Math.max(1, info.segmentEnd - info.segmentStart)));
      }
      pos = end;
    }

    cues.sort(function (a, b) { return a.start - b.start; });
    for (var i = 0; i < cues.length; i++) {          // fill missing durations
      if (cues[i].end == null) {
        var next = cues[i + 1] ? cues[i + 1].start : cues[i].start + 3;
        cues[i].end = Math.min(next, cues[i].start + 5);
      }
    }
    // ASS files often repeat identical lines for karaoke/outline layers
    var seen = Object.create(null), unique = [];
    cues.forEach(function (c) {
      var k = c.start.toFixed(3) + '|' + c.end.toFixed(3) + '|' + c.text;
      if (!seen[k]) { seen[k] = 1; unique.push(c); }
    });
    return { cues: unique, srt: cuesToSrt(unique) };
  }

  /* ------------------------------------------------------------------ */
  /*  ffmpeg.wasm remux fallback                                         */
  /* ------------------------------------------------------------------ */
  var CDN = {
    ffmpegUmd: 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/umd/',   // main-thread library (plain <script>)
    ffmpegEsm: 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm/',   // worker (ES module)
    coreEsm:   'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/'      // ffmpeg itself (ES module + .wasm)
  };
  var _ffmpegPromise = null;

  function loadScript(url) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = url; s.onload = resolve;
      s.onerror = function () { reject(new Error('Could not download ' + url)); };
      document.head.appendChild(s);
    });
  }

  async function toBlobURL(url, mime, onBytes) {
    var res = await fetch(url);
    if (!res.ok) throw new Error('Download failed (' + res.status + ')');
    var total = +res.headers.get('content-length') || 0;
    var chunks = [], got = 0;
    if (res.body && res.body.getReader) {
      var reader = res.body.getReader();
      for (;;) {
        var r = await reader.read();
        if (r.done) break;
        chunks.push(r.value); got += r.value.length;
        if (onBytes && total) onBytes(got / total);
      }
    } else {
      chunks.push(new Uint8Array(await res.arrayBuffer()));
    }
    return URL.createObjectURL(new Blob(chunks, { type: mime }));
  }

  function getFFmpeg(onStatus) {
    if (_ffmpegPromise) return _ffmpegPromise;
    _ffmpegPromise = (async function () {
      if (!global.FFmpegWASM) {
        if (onStatus) onStatus('Downloading converter…', 0);
        await loadScript(CDN.ffmpegUmd + 'ffmpeg.js');
      }
      // Browsers refuse to start a Worker from another origin, so the worker is a tiny same-origin
      // blob module that simply imports the real worker from the CDN (module workers may do that).
      // Passing classWorkerURL makes ffmpeg.wasm start a *module* worker, which needs the ESM core.
      var classWorkerURL = URL.createObjectURL(new Blob(["import '" + CDN.ffmpegEsm + "worker.js';"], { type: 'text/javascript' }));
      var wasmURL = await toBlobURL(CDN.coreEsm + 'ffmpeg-core.wasm', 'application/wasm', function (p) {
        if (onStatus) onStatus('Downloading converter (one-time, ~30 MB)…', p);
      });
      var ff = new global.FFmpegWASM.FFmpeg();
      await ff.load({ classWorkerURL: classWorkerURL, coreURL: CDN.coreEsm + 'ffmpeg-core.js', wasmURL: wasmURL });
      return ff;
    })().catch(function (e) { _ffmpegPromise = null; throw e; });
    return _ffmpegPromise;
  }

  /* Build the ffmpeg argument list (exported so it can be tested natively). */
  function remuxArgs(input, output, audioIndex, audioMode, hasAudio) {
    var args = ['-i', input, '-map', '0:v:0'];
    if (hasAudio) args.push('-map', '0:a:' + audioIndex);
    args.push('-c:v', 'copy');
    if (hasAudio) {
      if (audioMode === 'copy') args.push('-c:a', 'copy');
      else args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');
    }
    args.push('-sn', '-dn', '-map_chapters', '-1', '-movflags', '+faststart', '-f', 'mp4', output);
    return args;
  }

  /*  Returns { blob }.  opts: audioIndex, audioMode, hasAudio, onStatus(msg, 0..1), signal  */
  async function remux(file, opts) {
    opts = opts || {};
    var onStatus = opts.onStatus || function () {};
    var ff = await getFFmpeg(onStatus);
    if (opts.signal && opts.signal.aborted) throw new Error('Cancelled');

    var onProgress = function (e) {
      var p = e && typeof e.progress === 'number' ? Math.max(0, Math.min(1, e.progress)) : 0;
      onStatus(opts.audioMode === 'aac' ? 'Converting audio…' : 'Preparing video…', p);
    };
    var onAbort = function () { try { ff.terminate(); } catch (e) {} _ffmpegPromise = null; };
    if (opts.signal) opts.signal.addEventListener('abort', onAbort);

    try {
      try { await ff.createDir('/in'); } catch (e) { /* already exists */ }
      await ff.mount('WORKERFS', { blobs: [{ name: 'input.mkv', data: file }] }, '/in');   // reads lazily, no full copy
      ff.on('progress', onProgress);
      onStatus('Preparing video…', 0);
      var code = await ff.exec(remuxArgs('/in/input.mkv', 'out.mp4', opts.audioIndex || 0, opts.audioMode || 'aac', opts.hasAudio !== false));
      if (code !== 0) throw new Error('Conversion failed (code ' + code + ')');
      var data = await ff.readFile('out.mp4');
      var blob = new Blob([data], { type: 'video/mp4' });
      try { await ff.deleteFile('out.mp4'); } catch (e) {}
      return { blob: blob };
    } finally {
      try { ff.off('progress', onProgress); } catch (e) {}
      try { await ff.unmount('/in'); } catch (e) {}
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    }
  }

  function describeTrack(t) {
    var parts = [];
    if (t.name) parts.push(t.name);
    if (t.lang && t.lang !== 'und') parts.push(t.lang.toUpperCase());
    return parts.join(' - ');
  }

  global.SnuggleMkv = {
    probe: probe, plan: plan, extractSubtitle: extractSubtitle, remux: remux,
    describeTrack: describeTrack,
    _internals: { remuxArgs: remuxArgs, cuesToSrt: cuesToSrt, payloadToText: payloadToText }
  };
})(typeof window !== 'undefined' ? window : globalThis);
