// Battle City co-op client (rollback netcode edition).
//
// Replaces the old wasm-bindgen `client.js` + `client_bg.wasm`. Drop-in compatible with the page:
//   import init, { mount } from './pkg/client.js';
// All deterministic work (NES emulation, input prediction, rollback, desync detection) lives in
// `bcore_bg.wasm`; this file does signaling, WebRTC, rendering, audio, input and the page hooks.
import initCore, { Session } from './bcore.js';

const FRAME_MS = 1000 / 60.0988;
const T_HASH = 1, T_PING = 2, T_PONG = 3, T_START = 0x30, T_STATE = 0x21, T_STATE_REQ = 0x20;
const PAD = { A: 1, B: 2, SELECT: 4, START: 8, UP: 16, DOWN: 32, LEFT: 64, RIGHT: 128 };
const KEYMAP = {
  ArrowUp: PAD.UP, ArrowDown: PAD.DOWN, ArrowLeft: PAD.LEFT, ArrowRight: PAD.RIGHT,
  KeyX: PAD.A, KeyZ: PAD.B, Enter: PAD.START, ShiftLeft: PAD.SELECT, ShiftRight: PAD.SELECT,
};

let core = null;
export default async function init(moduleOrPath) {
  if (!core) core = await initCore(moduleOrPath);
  return core;
}
export function start() {}

const CSS = `
.bcoop{box-sizing:border-box;width:100%;max-width:768px;margin:0 auto;font:14px/1.4 system-ui,sans-serif;color:#eee}
.bcoop *{box-sizing:border-box}
.bcoop-stage{position:relative;width:100%;aspect-ratio:4/3;background:#000;border-radius:6px;overflow:hidden}
.bcoop-canvas{display:block;width:100%;height:100%;image-rendering:pixelated;image-rendering:crisp-edges;outline:none;background:#000}
.bcoop-overlay{position:absolute;inset:0;display:flex;flex-direction:column;gap:14px;align-items:center;justify-content:center;background:rgba(0,0,0,.6);text-align:center;padding:16px;pointer-events:none}
.bcoop-overlay[hidden]{display:none}
.bcoop-overlay.bcoop-failed .bcoop-msg{color:#ff8d8d}
.bcoop-bar{display:flex;gap:10px;align-items:center;padding:6px 2px;color:#bbb;font-size:13px}
.bcoop-hud{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bcoop-btn{background:#333;color:#eee;border:1px solid #555;border-radius:4px;padding:3px 10px;cursor:pointer;font:inherit}
.bcoop-btn:hover{background:#444}`;

function attr(el, name, dflt) { const v = el.getAttribute('data-' + name); return v === null ? dflt : v; }
const nowMs = () => performance.now();

export function mount(elementId) {
  const host = document.getElementById(elementId);
  if (!host) throw new Error('mount: no element with id ' + elementId);
  const room = attr(host, 'room', '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(room)) throw new Error('data-room must be 1-64 characters of A-Z a-z 0-9 _ -');
  const wsUrl = attr(host, 'ws-url', '');
  if (!/^wss?:\/\//.test(wsUrl)) throw new Error('data-ws-url must start with ws:// or wss://');
  const romUrl = attr(host, 'rom-url', './rom/battle-city.nes');
  const peerTimeoutMs = Number(attr(host, 'peer-timeout-ms', '60000')) || 60000;
  const debug = attr(host, 'debug', 'false') === 'true';
  let iceServers;
  try { iceServers = JSON.parse(attr(host, 'ice-servers', '[{"urls":"stun:stun.l.google.com:19302"}]')); }
  catch (e) { throw new Error('data-ice-servers is not valid JSON: ' + e.message); }

  // ---------- DOM ----------
  if (!document.getElementById('bcoop-style')) {
    const st = document.createElement('style'); st.id = 'bcoop-style'; st.textContent = CSS; document.head.appendChild(st);
  }
  host.textContent = '';
  const root = document.createElement('div'); root.className = 'bcoop';
  const stage = document.createElement('div'); stage.className = 'bcoop-stage';
  const canvas = document.createElement('canvas'); canvas.className = 'bcoop-canvas';
  canvas.width = 256; canvas.height = 240; canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', 'Battle City game screen');
  const g2d = canvas.getContext('2d', { alpha: false, desynchronized: true });
  g2d.fillStyle = '#000'; g2d.fillRect(0, 0, 256, 240);
  const overlay = document.createElement('div'); overlay.className = 'bcoop-overlay';
  overlay.setAttribute('role', 'status'); overlay.setAttribute('aria-live', 'polite');
  const msgEl = document.createElement('div'); msgEl.className = 'bcoop-msg'; overlay.appendChild(msgEl);
  stage.append(canvas, overlay);
  const bar = document.createElement('div'); bar.className = 'bcoop-bar';
  const hud = document.createElement('span'); hud.className = 'bcoop-hud';
  hud.textContent = 'Move: arrows / WASD    Fire: X, K or Space    Start: Enter    Select: Shift';
  const soundBtn = document.createElement('button'); soundBtn.className = 'bcoop-btn'; soundBtn.textContent = 'Sound on';
  soundBtn.setAttribute('aria-pressed', 'true');
  const fsBtn = document.createElement('button'); fsBtn.className = 'bcoop-btn'; fsBtn.textContent = 'Fullscreen';
  bar.append(hud, soundBtn, fsBtn);
  root.append(stage, bar); host.appendChild(root);

  function say(text, failed) {
    overlay.hidden = !text; msgEl.textContent = text || '';
    overlay.classList.toggle('bcoop-failed', !!failed);
  }

  // ---------- shared state / page hooks ----------
  const S = (window.__bc_state = window.__bc_state || {});
  S.isLocalInactive = false; S.isPeerPaused = false; S.peerPresent = false; S.pauseChannel = null;
  let resyncCount = 0, noRetry = false, stopped = false, status = 'loading', session = null, rom = null;
  let ws = null, serverSlot = null, pc = null, chControl = null, chInput = null, chPause = null;
  let channelsOpen = false, begun = false, running = false, online = false, resyncPending = 0;
  let rttMs = 60, lastStallAt = 0, stalledSince = 0, lastStatusSent = '';
  let pendingSignals = [], pendingIce = [], remoteDescSet = false;
  let rxState = null, lastHudAt = 0, padBits = 0, acc = 0, lastT = 0, raf = 0, pingTimer = 0, joinSent = false;

  function emit(st, extra) {
    status = st;
    const key = st + (extra ? JSON.stringify(extra) : '');
    if (key === lastStatusSent) return;
    lastStatusSent = key;
    host.dispatchEvent(new CustomEvent('bcoop:status', { detail: { status: st, slot: localSlot(), ...extra } }));
  }
  const localSlot = () => (typeof window.__bc_selected_slot === 'number' ? window.__bc_selected_slot : (serverSlot ?? 0)) & 1;
  const isHost = () => serverSlot === 0;
  const fire = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));
  const paused = () => !!(S.isLocalInactive || (online && S.isPeerPaused));
  window.__bc_is_game_paused = paused;
  window.__bc_resume_raf = () => { lastT = nowMs(); if (!raf && !stopped) raf = requestAnimationFrame(frameLoop); };

  // ---------- audio: jitter-buffered scheduling ----------
  const AC = window.AudioContext || window.webkitAudioContext;
  const actx = AC ? new AC({ latencyHint: 'interactive' }) : null;
  const gain = actx ? actx.createGain() : null;
  if (gain) gain.connect(actx.destination);
  window.__bc_audio_ctx = actx;
  let muted = false, audioCursor = 0, lead = 0.07, underruns = 0, lastUnderrun = 0;
  function applyMute() { if (gain) gain.gain.value = (muted || window.__bc_audio_muted) ? 0 : 1; soundBtn.textContent = muted ? 'Sound off' : 'Sound on'; soundBtn.setAttribute('aria-pressed', String(!muted)); }
  soundBtn.addEventListener('click', () => { muted = !muted; applyMute(); actx?.resume?.().catch(() => {}); });
  fsBtn.addEventListener('click', () => { if (window.__bc_toggle_fullscreen) window.__bc_toggle_fullscreen(); else stage.requestFullscreen?.(); });
  function pushAudio() {
    if (!actx || actx.state !== 'running' || muted || window.__bc_audio_muted) return;
    const n = session.audio_len(); if (!n) return;
    const view = new Float32Array(core.memory.buffer, session.audio_ptr(), n);
    const buf = actx.createBuffer(1, n, actx.sampleRate); buf.copyToChannel(view, 0);
    const src = actx.createBufferSource(); src.buffer = buf; src.connect(gain);
    const t = actx.currentTime;
    if (audioCursor < t + 0.005) {            // underrun: re-prime the cushion (grow it if it keeps happening)
      if (audioCursor !== 0 && t - lastUnderrun < 3) lead = Math.min(0.2, lead + 0.02);
      if (audioCursor !== 0) lastUnderrun = t;
      audioCursor = t + lead;
    }
    if (audioCursor - t > lead + 0.25) return; // burst after a rollback/stall: drop instead of drifting late
    src.start(audioCursor); audioCursor += buf.duration;
  }

  // ---------- input ----------
  function setKey(code, down) {
    const bit = KEYMAP[code]; if (!bit) return false;
    padBits = down ? (padBits | bit) : (padBits & ~bit); return true;
  }
  const onKeyDown = (e) => { if (e.repeat && KEYMAP[e.code]) { e.preventDefault(); return; } if (setKey(e.code, true)) { actx?.resume?.().catch(() => {}); if (e.cancelable && e.isTrusted) e.preventDefault(); } };
  const onKeyUp = (e) => { if (setKey(e.code, false) && e.cancelable && e.isTrusted) e.preventDefault(); };
  const onBlur = () => { padBits = 0; };
  window.addEventListener('keydown', onKeyDown); window.addEventListener('keyup', onKeyUp); window.addEventListener('blur', onBlur);

  // ---------- signaling ----------
  function wsSend(obj) { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (_) {} }
  window.__bc_broadcast_slot = (slot) => wsSend({ type: 'signal', data: { type: 'slot_choice', slot } });
  window.__bc_broadcast_mode = (mode) => wsSend({ type: 'signal', data: { type: 'mode_choice', mode } });
  window.__bc_broadcast_start = (mode) => wsSend({ type: 'signal', data: { type: 'start_game', kind: 'start_game', mode } });
  window.__bc_flush_pending_signals = () => { if (window.__bc_slots_confirmed) onBegin(); };

  function connectWs() {
    if (stopped) return;
    ws = new WebSocket(`${wsUrl}${wsUrl.includes('?') ? '&' : '?'}room=${encodeURIComponent(room)}`);
    S.ws = ws;
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (_) { return; } onServerMsg(m); };
    ws.onclose = () => { if (!stopped && !noRetry) { if (!channelsOpen) emit('failed'); setTimeout(connectWs, 1500); } };
    ws.onerror = () => {};
  }

  function onServerMsg(m) {
    if (m.type === 'welcome') {
      serverSlot = m.slot; S.localSlot = localSlot(); S.peerPresent = !!m.peer_present;
      fire('bc:peer_presence', { present: !!m.peer_present });
      if (m.peer_present) { window.__bc_broadcast_slot(localSlot()); startPeerConnection(); }
      emit(begun ? status : 'waiting-for-peer');
    } else if (m.type === 'peer_joined') {
      S.peerPresent = true; fire('bc:peer_presence', { present: true });
      window.__bc_broadcast_slot(localSlot()); startPeerConnection();
    } else if (m.type === 'peer_left') {
      S.peerPresent = false; window.__bc_peer_selected_slot = null; window.__bc_slots_confirmed = false;
      fire('bc:peer_presence', { present: false }); fire('bc:peer_slot_choice', { slot: null });
      teardownPeer(); begun = false; running = false; online = false;
      say('Your partner left the game.'); emit('peer-left');
    } else if (m.type === 'error') {
      if (m.code === 'room_full') { say('This room already has two players.', true); noRetry = true; emit('failed'); }
      else if (m.code !== 'preempted') console.warn('signal error', m);
    } else if (m.type === 'signal' && m.data) {
      const d = m.data, k = d.type || d.kind;
      if (k === 'slot_choice') { window.__bc_peer_selected_slot = d.slot; fire('bc:peer_slot_choice', { slot: d.slot }); }
      else if (k === 'mode_choice') fire('bc:peer_mode_choice', { mode: d.mode });
      else if (k === 'start_game') fire('bc:peer_start_game', { mode: d.mode });
      else if (d.kind === 'offer' || d.kind === 'answer' || d.kind === 'ice') handleRtcSignal(d);
    }
  }

  // ---------- WebRTC ----------
  function startPeerConnection() {
    if (pc || stopped) return;
    pc = new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 4, bundlePolicy: 'max-bundle' });
    remoteDescSet = false; pendingIce = [];
    chControl = pc.createDataChannel('control', { negotiated: true, id: 0, ordered: true });
    chInput = pc.createDataChannel('input', { negotiated: true, id: 1, ordered: false, maxRetransmits: 0 });
    chPause = pc.createDataChannel('snuggle_pause', { negotiated: true, id: 2, ordered: true });
    chControl.binaryType = 'arraybuffer'; chInput.binaryType = 'arraybuffer';
    S.pauseChannel = chPause;
    chInput.onmessage = (e) => { if (online && session && running) session.recv_packet(new Uint8Array(e.data)); };
    chControl.onmessage = (e) => onControl(new Uint8Array(e.data));
    chPause.onmessage = (e) => { try { window.__bc_on_pause_message?.(JSON.parse(e.data)); } catch (_) {} };
    const maybeOpen = () => {
      if (channelsOpen || chControl.readyState !== 'open' || chInput.readyState !== 'open') return;
      channelsOpen = true; onChannelsOpen();
    };
    chControl.onopen = maybeOpen; chInput.onopen = maybeOpen;
    const onClosed = () => { if (channelsOpen && !stopped) { channelsOpen = false; if (running) { say('Lost contact with the other player.', true); emit('failed'); } } };
    chControl.onclose = onClosed;
    pc.onicecandidate = (ev) => { if (ev.candidate) wsSend({ type: 'signal', data: { kind: 'ice', candidate: ev.candidate.candidate, sdpMid: ev.candidate.sdpMid, sdpMLineIndex: ev.candidate.sdpMLineIndex } }); };
    let discTimer = 0;
    pc.oniceconnectionstatechange = () => {
      const s = pc?.iceConnectionState;
      if (s === 'disconnected') { clearTimeout(discTimer); discTimer = setTimeout(() => { if (pc?.iceConnectionState !== 'connected' && pc?.iceConnectionState !== 'completed') { say('Lost contact with the other player.', true); emit('failed'); } }, peerTimeoutMs); }
      else if (s === 'failed') { try { pc.restartIce(); } catch (_) {} }
      else clearTimeout(discTimer);
    };
    if (!begun) emit('negotiating');
    if (isHost()) makeOffer();
    for (const d of pendingSignals.splice(0)) handleRtcSignal(d);
  }
  async function makeOffer() {
    try { const o = await pc.createOffer(); await pc.setLocalDescription(o); wsSend({ type: 'signal', data: { kind: 'offer', sdp: pc.localDescription.sdp } }); }
    catch (e) { console.warn('offer failed', e); }
  }
  async function handleRtcSignal(d) {
    if (!pc) { pendingSignals.push(d); return; }
    try {
      if (d.kind === 'offer' && !isHost()) {
        await pc.setRemoteDescription({ type: 'offer', sdp: d.sdp }); remoteDescSet = true;
        const a = await pc.createAnswer(); await pc.setLocalDescription(a);
        wsSend({ type: 'signal', data: { kind: 'answer', sdp: pc.localDescription.sdp } });
        for (const c of pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      } else if (d.kind === 'answer' && isHost()) {
        await pc.setRemoteDescription({ type: 'answer', sdp: d.sdp }); remoteDescSet = true;
        for (const c of pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      } else if (d.kind === 'ice') {
        const c = { candidate: d.candidate, sdpMid: d.sdpMid, sdpMLineIndex: d.sdpMLineIndex };
        if (remoteDescSet) await pc.addIceCandidate(c).catch(() => {}); else pendingIce.push(c);
      }
    } catch (e) { console.warn('rtc signal error', e); }
  }
  function teardownPeer() {
    channelsOpen = false; clearInterval(pingTimer); joinSent = false;
    try { chControl?.close(); chInput?.close(); chPause?.close(); pc?.close(); } catch (_) {}
    pc = chControl = chInput = chPause = null; S.pauseChannel = null; pendingSignals = []; resyncPending = 0;
  }

  // ---------- control channel ----------
  function sendCtl(type, payload) {
    if (!chControl || chControl.readyState !== 'open') return;
    const body = payload || new Uint8Array(0), m = new Uint8Array(1 + body.length); m[0] = type; m.set(body, 1);
    try { chControl.send(m); } catch (_) {}
  }
  function sendState(bytes, keepInputs) {
    const hdr = new Uint8Array(6); new DataView(hdr.buffer).setUint32(0, bytes.length, true); hdr[4] = keepInputs ? 1 : 0; hdr[5] = localSlot();
    sendCtl(T_STATE, hdr);
    for (let o = 0; o < bytes.length; o += 15000) sendCtl(T_STATE + 1, bytes.subarray(o, o + 15000));
  }
  function onControl(m) {
    const t = m[0], body = m.subarray(1);
    if (t === T_PING) { sendCtl(T_PONG, body); }
    else if (t === T_PONG) {
      const sent = new DataView(body.buffer, body.byteOffset, 8).getFloat64(0, true);
      const sample = nowMs() - sent; rttMs = rttMs * 0.7 + sample * 0.3; session?.set_rtt_ms(rttMs);
      session?.set_max_pred(Math.max(8, Math.min(18, Math.ceil(rttMs / FRAME_MS) + 4)));
    } else if (t === T_HASH) {
      if (!session || !online) return;
      const bad = session.check_hash_report(body);
      if (bad >= 0) requestResync();
    } else if (t === T_START) {
      // Host says: fresh game from power-on. Adopt the host's slot assignment.
      window.__bc_selected_slot = 1 - (body[0] & 1);
      fire('bc:peer_start_game', {}); // makes the page hide the lobby / show controls
      beginOnline(false);
    } else if (t === T_STATE_REQ) {
      if (!session || !online || !isHost()) return;
      const f = session.best_final_frame(); if (f < 0) return;
      const st = session.export_state(f); if (st.length) sendState(st, true);
    } else if (t === T_STATE) {
      const dv = new DataView(body.buffer, body.byteOffset, 6);
      rxState = { len: dv.getUint32(0, true), keep: body[4] === 1, hostSlot: body[5] & 1, got: 0, buf: new Uint8Array(dv.getUint32(0, true)) };
    } else if (t === T_STATE + 1 && rxState) {
      rxState.buf.set(body, rxState.got); rxState.got += body.length;
      if (rxState.got >= rxState.len) { const r = rxState; rxState = null; adoptState(r); }
    }
  }
  function requestResync() {
    if (isHost()) return; // the host's state is authoritative; the guest asks for it
    if (nowMs() - resyncPending < 2500) return;
    resyncPending = nowMs(); resyncCount++; sendCtl(T_STATE_REQ);
  }
  function adoptState(r) {
    try {
      if (r.keep) { session.import_state(r.buf, true); resyncPending = 0; return; }
      // Joining a game that is already in progress on the host.
      window.__bc_selected_slot = 1 - r.hostSlot;
      session.set_local_slot(localSlot()); session.set_input_delay(currentDelay());
      session.import_state(r.buf, false); session.set_solo(false);
      session.set_rtt_ms(rttMs);
      fire('bc:peer_start_game', {}); begun = true; running = true; online = true; startLoop(); say('');
    } catch (e) { console.warn('state import failed', e); emit('failed'); }
  }

  // ---------- starting a game ----------
  const currentDelay = () => Math.max(1, Math.min(4, Math.round(rttMs / 40)));
  function ensureSession() {
    session.set_local_slot(localSlot());
    session.set_max_pred(Math.max(8, Math.min(18, Math.ceil(rttMs / FRAME_MS) + 4)));
    session.set_rtt_ms(rttMs);
  }
  function beginOnline(asHost) {
    ensureSession();
    session.reset(false, currentDelay()); online = true; running = true; audioCursor = 0; say(''); startLoop(); emit('playing');
    if (asHost) sendCtl(T_START, new Uint8Array([localSlot()]));
  }
  function onBegin() {
    if (!session || begun && running) return;
    begun = true;
    if (channelsOpen) {
      if (isHost()) beginOnline(true);
      else { say('Syncing with your partner…'); emit('syncing'); } // wait for the host's start message
    } else if (S.peerPresent) {
      say('Connecting to your partner…'); emit('negotiating');   // channels still opening; onChannelsOpen continues
    } else {
      ensureSession(); session.reset(true, 0); online = false; running = true; audioCursor = 0; say(''); startLoop(); emit('playing');
    }
  }
  function onChannelsOpen() {
    pingTimer = setInterval(() => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, nowMs(), true); sendCtl(T_PING, b); }, 500);
    const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, nowMs(), true); sendCtl(T_PING, b);
    if (!isHost()) return;
    if (running && !online && session.frame() > 120 && !joinSent) {
      // A friend arrived while we were already playing alone: hand them the live game.
      joinSent = true; ensureSession();
      const st = session.export_current(); session.go_online(); online = true;
      sendState(st, false); emit('playing');
    } else if (begun) {
      setTimeout(() => { if (channelsOpen && begun) beginOnline(true); }, 150); // let a few RTT samples land first
    }
  }

  // ---------- main loop ----------
  function startLoop() { lastT = nowMs(); acc = 0; if (!raf && !stopped) raf = requestAnimationFrame(frameLoop); }
  let framesDrawn = 0;
  function draw() {
    const w = session.width(), h = session.height();
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const px = new Uint8ClampedArray(core.memory.buffer, session.video_ptr(), session.video_len());
    g2d.putImageData(new ImageData(px, w, h), 0, 0);
    framesDrawn++;
  }
  function frameLoop(t) {
    raf = 0; if (stopped || !session || !running) return;
    raf = requestAnimationFrame(frameLoop);
    const dt = Math.min(100, t - lastT); lastT = t;
    if (paused()) { acc = 0; return; }
    const period = FRAME_MS * session.time_scale();
    acc += dt;
    let steps = 0, drew = false;
    while (acc >= period && steps < 4) {
      session.set_local_pad(padBits);
      const r = session.tick();
      if (r === 1) { // stalled: waiting on the partner's input window
        if (!stalledSince) stalledSince = t;
        acc = Math.min(acc, period); lastStallAt = t;
        if (t - stalledSince > 600) { say('Syncing frames…'); emit('syncing'); }
        break;
      }
      if (stalledSince) { stalledSince = 0; say(''); emit('playing'); }
      acc -= period; steps++; drew = true;
      pushAudio();
      if (online) {
        const rep = session.take_hash_report(); if (rep.length) sendCtl(T_HASH, rep);
        if (session.take_desync() >= 0) requestResync();
      }
    }
    if (acc > period * 6) acc = 0;           // never spiral: drop backlog instead of fast-forwarding
    if (drew) draw();
    if (online && chInput && chInput.readyState === 'open') {
      try { if (chInput.bufferedAmount < 16384) chInput.send(session.build_packet()); } catch (_) {}
    }
    if (t - lastHudAt > 500) { lastHudAt = t; updateHud(); }
  }
  function updateHud() {
    if (!online) { hud.textContent = 'Move: arrows / WASD    Fire: X, K or Space    Start: Enter    Select: Shift'; return; }
    const s = JSON.parse(session.stats_json());
    hud.textContent = `Ping ${Math.round(rttMs)} ms · delay ${s.delay}f · predicting ${s.pred}f · rollbacks ${s.rollbacks}`;
  }

  // ---------- boot ----------
  (async () => {
    say('Loading emulator…'); emit('loading');
    try {
      await init();
      const res = await fetch(romUrl); if (!res.ok) throw new Error('ROM download failed: ' + res.status);
      rom = new Uint8Array(await res.arrayBuffer());
      const rate = actx ? actx.sampleRate : 48000;
      session = new Session(rom, localSlot(), true, 1, 12, rate);
      applyMute(); draw(); say('');
      if (debug) window.__bc_session = session;
      connectWs();
      emit('waiting-for-peer');
      if (window.__bc_slots_confirmed) onBegin();
    } catch (e) {
      console.error(e); say('Could not load the game: ' + (e.message || e), true); emit('failed');
    }
  })();

  // ---------- public handle ----------
  const game = {
    set_muted(m) { muted = !!m; applyMute(); },
    status() { return status; },
    debug_json() { return JSON.stringify({ status, rtt_ms: Math.round(rttMs), online, running, channelsOpen, serverSlot, session: session ? JSON.parse(session.stats_json()) : null, lead, framesDrawn, resyncCount }); },
    debug_corrupt() { if (debug && session) session.debug_corrupt(); },
    debug_set_pad(p) { padBits |= p; },
    stop() {
      if (stopped) return; stopped = true; cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); window.removeEventListener('blur', onBlur);
      teardownPeer(); try { ws?.close(); } catch (_) {}
      try { actx?.close(); } catch (_) {}
      try { session?.free(); } catch (_) {}
      host.textContent = '';
      host.dispatchEvent(new CustomEvent('bcoop:ended', { detail: { message: 'Game session ended' } }));
    },
  };
  return game;
}
