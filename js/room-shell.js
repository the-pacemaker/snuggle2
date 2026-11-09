/* =============================================
   SNUGGLE — Room Shell Controller (room-shell.js)
   Manages the persistent WebRTC video call,
   the two-tab bottom ribbon, and the draggable
   floating Picture-in-Picture (PiP) pop-up.
   ============================================= */

(function () {
  'use strict';

  // ── Configuration ──────────────────────────────
  const WS_URL = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;
  const RTC_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' },
      { urls: 'stun:openrelay.metered.ca:80' },
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turns:openrelay.metered.ca:443?transport=tcp',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      }
    ],
    iceCandidatePoolSize: 0
  };

  // Fetch updated ICE servers (with TURN relay) from backend if available
  fetch('/api/ice-servers')
    .then(r => r.json())
    .then(data => {
      if (Array.isArray(data && data.iceServers) && data.iceServers.length > 0) {
        RTC_CONFIG.iceServers = data.iceServers;
      }
    })
    .catch(() => {});

  // ── State ───────────────────────────────────────
  const sessionId = (window.SnuggleInvite && window.SnuggleInvite.getSessionId) ? window.SnuggleInvite.getSessionId() : Math.random().toString(36).slice(2, 10);
  const clientId = `${sessionId}_${Math.random().toString(36).slice(2, 8)}`;
  let ROOM_CODE = '';
  let activeTab = 'site'; // 'site' or 'call'
  let ws = null;
  let pc = null;
  let localStream = null;
  let remoteStream = null;
  let iceQueue = [];
  let isPolite = false;
  let makingOffer = false;
  let ignoreOffer = false;
  let isSettingRemoteAnswerPending = false;
  let remoteClientId = null;
  let currentFacingMode = 'user';
  let isMicMuted = false;
  let isCamOff = false;
  let hasMultipleCameras = false;
  let pingInterval = null;
  let isCallActive = false; // Whether local user has joined the call
  let isFriendInCall = false; // Whether friend has joined/started the call
  let usersCount = 1;
  let toastTimer = null;

  // ── DOM References ─────────────────────────────
  const $ = (id) => document.getElementById(id);
  const roomShell = $('room-shell');
  const shellViewport = $('shell-viewport');
  const siteSection = $('shell-site-section');
  const callSection = $('shell-call-section');
  const siteFrame = $('shell-site-frame');
  const tabCall = $('tab-call');
  const tabSite = $('tab-site');
  const ribbonCallBadge = $('ribbon-call-badge');
  const snuggleRibbon = $('snuggle-ribbon');
  const ribbonPeekPill = $('ribbon-peek-pill');
  const shellToast = $('shell-toast');
  const remoteAudio = $('remote-audio');

  // Call Stage Elements
  const stageRemoteVideo = $('stage-remote-video');
  const stageLocalVideo = $('stage-local-video');
  const remoteContainer = $('remote-container');
  const localContainer = $('local-container');
  const callStage = $('call-stage');
  const remotePlaceholder = $('remote-placeholder');
  const remotePlaceholderText = $('remote-placeholder-text');
  const localPlaceholder = $('local-placeholder');
  const remoteMutedBadge = $('remote-muted-badge');
  const callStatusDot = $('call-status-dot');
  const callStatusText = $('call-status-text');
  const callRoomCode = $('call-room-code');
  const callRoomPill = $('call-room-pill');
  const btnStartCall = $('btn-start-call');
  const callIdleActions = $('call-idle-actions');
  const callTabBackBtn = $('call-tab-back-btn');

  // Controls
  const ctrlMic = $('ctrl-mic');
  const iconMicOn = $('icon-mic-on');
  const iconMicOff = $('icon-mic-off');
  const ctrlCam = $('ctrl-cam');
  const iconCamOn = $('icon-cam-on');
  const iconCamOff = $('icon-cam-off');
  const ctrlSwitchCam = $('ctrl-switch-cam');
  const ctrlSwap = $('ctrl-swap');
  const ctrlLeave = $('ctrl-leave');

  // PiP Elements
  const snugglePip = $('snuggle-pip');
  const pipStatusDot = $('pip-status-dot');
  const pipVideoClickArea = $('pip-video-click-area');
  const pipRemoteVideo = $('pip-remote-video');
  const pipAvatarFallback = $('pip-avatar-fallback');
  const pipLocalInset = $('pip-local-inset');
  const pipLocalVideo = $('pip-local-video');
  const pipJoinPrompt = $('pip-join-prompt');
  const pipJoinBtn = $('pip-join-btn');
  const pipCtrlMic = $('pip-ctrl-mic');
  const pipIconMicOn = $('pip-icon-mic-on');
  const pipIconMicOff = $('pip-icon-mic-off');
  const pipCtrlExpand = $('pip-ctrl-expand');
  const pipCtrlClose = $('pip-ctrl-close');
  const callHeaderTimer = $('call-header-timer');
  const remoteSpeakingIndicator = $('remote-speaking-indicator');
  const localSpeakingIndicator = $('local-speaking-indicator');
  const pipSpeakingIndicator = $('pip-speaking-indicator');

  // Permission & HTTPS Dialog
  const permDialog = $('permission-dialog');
  const permDialogDesc = $('perm-dialog-desc');
  const btnRetryPerm = $('btn-retry-perm');
  const btnSwitchHttps = $('btn-switch-https');

  // Share & Connect Phone Modal
  const shareModal = $('share-modal');
  const shareQrImg = $('share-qr-img');
  const shareModalCode = $('share-modal-code');
  const btnCopyShareUrl = $('btn-copy-share-url');
  const btnCloseShareModal = $('btn-close-share-modal');

  // ── Secure Context & HTTPS Mobile Support ──────
  function checkSecureContext() {
    const isLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname);
    if (!window.isSecureContext && !isLocal) {
      if (permDialogDesc && btnSwitchHttps) {
        permDialogDesc.textContent = 'Mobile browsers require a secure HTTPS connection for camera and microphone access. Tap below to switch to the secure HTTPS connection on your local network:';
        btnSwitchHttps.href = `https://${window.location.hostname}:3443${window.location.pathname}${window.location.search}`;
        btnSwitchHttps.style.display = 'block';
      }
      if (permDialog) permDialog.hidden = false;
      setStatus('disconnected', 'HTTPS required on mobile');
      return false;
    }
    return true;
  }

  // ── Toast Notification ─────────────────────────
  function showToast(message, duration = 3200) {
    if (!shellToast) return;
    shellToast.textContent = message;
    shellToast.classList.add('is-active');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      shellToast.classList.remove('is-active');
    }, duration);
  }

  // ── Status Helpers ─────────────────────────────
  function setStatus(state, label) {
    if (callStatusDot) {
      callStatusDot.className = 'call-status__dot';
      if (state === 'connected') {
        callStatusDot.classList.add('is-connected');
      } else if (state === 'waiting') {
        callStatusDot.classList.add('is-waiting');
      } else if (state === 'disconnected') {
        callStatusDot.classList.add('is-disconnected');
      }
    }

    if (callStatusText) {
      callStatusText.textContent = label;
    }
    const statusEls = document.querySelectorAll('.call-status-text, .call-status__text');
    statusEls.forEach(el => { el.textContent = label; });

    if (pipStatusDot) {
      if (state === 'connected') {
        pipStatusDot.className = 'pip-status-dot is-live';
      } else {
        pipStatusDot.className = 'pip-status-dot';
      }
    }
  }

  // ── Call Duration Timer ────────────────────────
  let callStartTime = null;
  let callTimerInterval = null;

  function startCallTimer() {
    if (callTimerInterval) return;
    callStartTime = Date.now();
    updateCallTimerDisplay();
    callTimerInterval = setInterval(updateCallTimerDisplay, 1000);
  }

  function stopCallTimer() {
    if (callTimerInterval) {
      clearInterval(callTimerInterval);
      callTimerInterval = null;
    }
    callStartTime = null;
    const timerEls = document.querySelectorAll('.call-timer-text');
    timerEls.forEach(el => {
      el.textContent = '00:00';
      el.hidden = true;
    });
  }

  function updateCallTimerDisplay() {
    if (!callStartTime) return;
    const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
    const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const s = String(elapsed % 60).padStart(2, '0');
    const timeStr = `${m}:${s}`;
    const timerEls = document.querySelectorAll('.call-timer-text');
    timerEls.forEach(el => {
      el.textContent = timeStr;
      el.hidden = false;
    });
  }

  // ── Audio Speaking / Voice Activity Detection ──
  let audioCtx = null;
  let localAudioAnalyser = null;
  let remoteAudioAnalyser = null;
  let audioAnalysisInterval = null;

  function setupAudioAnalysis() {
    if (!window.AudioContext && !window.webkitAudioContext) return;
    try {
      if (!audioCtx || audioCtx.state === 'closed') {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AudioCtx();
      }
      if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }

      // Local microphone analyser
      if (localStream && localStream.getAudioTracks().length > 0 && !localAudioAnalyser) {
        try {
          const localSrc = audioCtx.createMediaStreamSource(localStream);
          localAudioAnalyser = audioCtx.createAnalyser();
          localAudioAnalyser.fftSize = 64;
          localAudioAnalyser.smoothingTimeConstant = 0.4;
          localSrc.connect(localAudioAnalyser);
        } catch (err) {
          console.warn('[Snuggle Shell] Local audio analyser init warning:', err);
        }
      }

      // Remote incoming audio analyser
      if (remoteStream && remoteStream.getAudioTracks().length > 0 && !remoteAudioAnalyser) {
        try {
          const remoteSrc = audioCtx.createMediaStreamSource(remoteStream);
          remoteAudioAnalyser = audioCtx.createAnalyser();
          remoteAudioAnalyser.fftSize = 64;
          remoteAudioAnalyser.smoothingTimeConstant = 0.4;
          remoteSrc.connect(remoteAudioAnalyser);
        } catch (err) {
          console.warn('[Snuggle Shell] Remote audio analyser init warning:', err);
        }
      }

      if (!audioAnalysisInterval) {
        const localBuf = new Uint8Array(32);
        const remoteBuf = new Uint8Array(32);
        audioAnalysisInterval = setInterval(() => {
          let localSpeaking = false;
          let remoteSpeaking = false;

          if (localAudioAnalyser && !isMicMuted && localStream) {
            localAudioAnalyser.getByteFrequencyData(localBuf);
            let total = 0;
            for (let i = 0; i < localBuf.length; i++) total += localBuf[i];
            if (total / localBuf.length > 18) localSpeaking = true;
          }

          if (remoteAudioAnalyser && remoteStream) {
            remoteAudioAnalyser.getByteFrequencyData(remoteBuf);
            let total = 0;
            for (let i = 0; i < remoteBuf.length; i++) total += remoteBuf[i];
            if (total / remoteBuf.length > 18) remoteSpeaking = true;
          }

          if (localSpeakingIndicator) {
            localSpeakingIndicator.classList.toggle('is-speaking', localSpeaking);
            localSpeakingIndicator.closest('.CallingAudioIndicator')?.classList.toggle('is-speaking', localSpeaking);
          }
          if (remoteSpeakingIndicator) {
            remoteSpeakingIndicator.classList.toggle('is-speaking', remoteSpeaking);
            remoteSpeakingIndicator.closest('.CallingAudioIndicator, .video-badge--remote')?.classList.toggle('is-speaking', remoteSpeaking);
          }
          if (pipSpeakingIndicator) {
            pipSpeakingIndicator.classList.toggle('is-speaking', remoteSpeaking);
          }
        }, 120);
      }
    } catch (e) {
      console.warn('[Snuggle Shell] AudioContext setup error:', e);
    }
  }

  function teardownAudioAnalysis() {
    if (audioAnalysisInterval) {
      clearInterval(audioAnalysisInterval);
      audioAnalysisInterval = null;
    }
    localAudioAnalyser = null;
    remoteAudioAnalyser = null;
    if (localSpeakingIndicator) {
      localSpeakingIndicator.classList.remove('is-speaking');
      localSpeakingIndicator.closest('.CallingAudioIndicator')?.classList.remove('is-speaking');
    }
    if (remoteSpeakingIndicator) {
      remoteSpeakingIndicator.classList.remove('is-speaking');
      remoteSpeakingIndicator.closest('.CallingAudioIndicator, .video-badge--remote')?.classList.remove('is-speaking');
    }
    if (pipSpeakingIndicator) pipSpeakingIndicator.classList.remove('is-speaking');
  }

  // ── Auto-Hide Call Controls (Signal Style) ───
  let controlsHideTimer = null;
  let areControlsVisible = true;
  let lastWakeTime = 0;

  function showControls(autoHide = true) {
    clearTimeout(controlsHideTimer);
    if (!areControlsVisible) {
      lastWakeTime = Date.now();
    }
    if (callSection) callSection.classList.remove('controls-hidden');
    areControlsVisible = true;
    showRibbon(false);
    if (autoHide && (isCallActive || isFriendInCall)) {
      controlsHideTimer = setTimeout(() => {
        hideControls();
      }, 3500);
    }
  }

  function hideControls() {
    if (activeTab === 'call') {
      if (callSection) callSection.classList.add('controls-hidden');
      areControlsVisible = false;
      hideRibbon();
    }
  }

  function toggleControls() {
    // If controls were just woken up in the last 400ms by pointermove/tap, keep them visible
    if (!areControlsVisible || (Date.now() - lastWakeTime < 400)) {
      showControls(true);
    } else {
      hideControls();
    }
  }

  // PiP Dismissal tracking
  let isPipDismissed = false;

  function dismissPip(e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    isPipDismissed = true;
    updatePipVisibility();
    showToast('Picture-in-picture removed. Open Video Call tab to restore.');
  }

  // ── Tab Navigation (Video Call vs Activities) ───
  function switchTab(targetTab) {
    activeTab = targetTab;

    if (activeTab === 'call') {
      isPipDismissed = false; // Visiting the video call tab restores PiP for when user navigates to site tab!
      if (roomShell) roomShell.classList.add('is-call-view');
      tabCall.classList.add('is-active');
      tabCall.setAttribute('aria-selected', 'true');
      tabSite.classList.remove('is-active');
      tabSite.setAttribute('aria-selected', 'false');

      callSection.classList.add('is-active');
      siteSection.classList.remove('is-active');

      // Hide floating PiP while in full call view
      snugglePip.hidden = true;
      snugglePip.style.display = 'none';

      // Clear the notification badge once visited
      ribbonCallBadge.hidden = true;

      // Show controls initially, auto-hide after 3.5s
      showControls(true);

      // If call is not yet joined, update lobby card
      if (!isCallActive) {
        updateCallLobbyUI();
        const hasLiveVideo = remoteStream && remoteStream.getVideoTracks().some(t => t.readyState === 'live' && !t.muted);
        if (hasLiveVideo) {
          if (remotePlaceholder) remotePlaceholder.hidden = true;
          pipAvatarFallback.hidden = true;
        } else {
          if (remotePlaceholder) remotePlaceholder.hidden = false;
          if (remotePlaceholderText) remotePlaceholderText.textContent = isFriendInCall ? 'Friend is on video call' : 'Start a video call with your friend anytime!';
        }
      }
    } else {
      // Switch to Website / Activities
      if (roomShell) roomShell.classList.remove('is-call-view');
      clearTimeout(controlsHideTimer);
      if (callSection) callSection.classList.remove('controls-hidden');

      tabSite.classList.add('is-active');
      tabSite.setAttribute('aria-selected', 'true');
      tabCall.classList.remove('is-active');
      tabCall.setAttribute('aria-selected', 'false');

      siteSection.classList.add('is-active');
      callSection.classList.remove('is-active');

      snugglePip.style.display = '';
      // If call is active or friend is in call, display the floating PiP (unless dismissed)
      updatePipVisibility();
      showRibbon(true);
    }
  }

  // ── Auto-Hide Bottom Navigation Ribbon ─────────
  let isRibbonHidden = false;
  let isRibbonHovered = false;
  let ribbonHideTimer = null;
  let accumScrollDown = 0;
  let accumScrollUp = 0;

  const SCROLL_HIDE_THRESHOLD = 18; // Pixels down to trigger hide
  const SCROLL_SHOW_THRESHOLD = 24; // "Big enough scroll" up to trigger reveal (Android pattern)
  const RIBBON_IDLE_DELAY = 3500;   // Inactivity delay before sliding down

  function getFrameScrollY() {
    try {
      const fw = siteFrame && siteFrame.contentWindow;
      const fd = siteFrame && (siteFrame.contentDocument || fw?.document);
      if (!fw || !fd) return 0;
      return fw.scrollY || fd.documentElement?.scrollTop || fd.body?.scrollTop || 0;
    } catch (_) {
      return 0;
    }
  }

  function hideRibbon() {
    if (isRibbonHovered) return;
    clearTimeout(ribbonHideTimer);
    isRibbonHidden = true;
    if (roomShell) roomShell.classList.add('ribbon-hidden');
    if (snuggleRibbon) snuggleRibbon.classList.add('is-hidden');
    accumScrollDown = 0;
    accumScrollUp = 0;
  }

  function scheduleRibbonHide(delay = RIBBON_IDLE_DELAY) {
    clearTimeout(ribbonHideTimer);
    if (isRibbonHovered || isRibbonHidden) return;
    ribbonHideTimer = setTimeout(() => {
      hideRibbon();
    }, delay);
  }

  // Returns true if the site frame (or top document) is currently in a fullscreen state,
  // including the pseudo-fullscreen class used by games like Battle City.
  function isFrameFullscreen() {
    if (document.fullscreenElement || document.webkitFullscreenElement) return true;
    try {
      const frameDoc = siteFrame && (siteFrame.contentDocument || siteFrame.contentWindow?.document);
      if (frameDoc && frameDoc.querySelector('.pseudo-fullscreen, .gp--pseudo')) return true;
    } catch (_) {}
    return false;
  }

  function showRibbon(autoHide = true) {
    // Never pop the ribbon up while a game is in fullscreen
    if (isFrameFullscreen()) return;

    clearTimeout(ribbonHideTimer);
    isRibbonHidden = false;
    if (roomShell) roomShell.classList.remove('ribbon-hidden');
    if (snuggleRibbon) snuggleRibbon.classList.remove('is-hidden');
    accumScrollDown = 0;
    accumScrollUp = 0;

    if (autoHide && !isRibbonHovered) {
      scheduleRibbonHide();
    }
  }

  function wakeRibbon() {
    // Never pop the ribbon up while a game is in fullscreen
    if (isFrameFullscreen()) return;

    if (isRibbonHidden) {
      showRibbon(true);
    } else {
      scheduleRibbonHide();
    }
  }

  function handleScrollDelta(deltaY, currentScrollY) {
    if (deltaY > 0) {
      // User is scrolling DOWN
      accumScrollDown += deltaY;
      accumScrollUp = 0;
      if (accumScrollDown >= SCROLL_HIDE_THRESHOLD) {
        hideRibbon();
      }
    } else if (deltaY < 0) {
      // User is scrolling UP
      accumScrollUp += Math.abs(deltaY);
      accumScrollDown = 0;
      if (currentScrollY <= 12 || accumScrollUp >= SCROLL_SHOW_THRESHOLD) {
        // Reappear when big enough scroll is made (Android pattern) or reached top
        showRibbon(true);
      }
    }
  }

  function attachScrollListenersToFrame() {
    try {
      const fw = siteFrame && siteFrame.contentWindow;
      const fd = siteFrame && (siteFrame.contentDocument || fw?.document);
      if (!fw || !fd) return;
      if (fw.__snuggleScrollAttached) return;
      fw.__snuggleScrollAttached = true;

      // 1. Native Scroll Event (window + document capture to intercept any container)
      let lastScrollPos = fw.scrollY || fd.documentElement?.scrollTop || fd.body?.scrollTop || 0;
      const onScrollEvent = (e) => {
        let currentY = 0;
        if (e && e.target && e.target !== fd && e.target !== fw && typeof e.target.scrollTop === 'number') {
          currentY = e.target.scrollTop;
        } else {
          currentY = fw.scrollY || fd.documentElement?.scrollTop || fd.body?.scrollTop || 0;
        }
        const delta = currentY - lastScrollPos;
        lastScrollPos = currentY;
        handleScrollDelta(delta, currentY);
      };
      fw.addEventListener('scroll', onScrollEvent, { passive: true });
      fd.addEventListener('scroll', onScrollEvent, { capture: true, passive: true });

      // 2. Mouse Wheel Event
      const onWheelEvent = (e) => {
        const currentY = fw.scrollY || fd.documentElement?.scrollTop || fd.body?.scrollTop || 0;
        handleScrollDelta(e.deltaY, currentY);
      };
      fw.addEventListener('wheel', onWheelEvent, { passive: true });
      fd.addEventListener('wheel', onWheelEvent, { passive: true });

      // 3. Touch Drag / Swipe (Mobile Android behavior)
      let lastTouchY = null;

      fd.addEventListener('touchstart', (e) => {
        if (e.touches && e.touches.length === 1) {
          lastTouchY = e.touches[0].clientY;
          accumScrollDown = 0;
          accumScrollUp = 0;
        }
      }, { passive: true });

      fd.addEventListener('touchmove', (e) => {
        if (lastTouchY === null || !e.touches || e.touches.length !== 1) return;
        const currentY = e.touches[0].clientY;
        const dy = lastTouchY - currentY; // positive = dragged up = content scrolled down
        lastTouchY = currentY;

        const scrollY = fw.scrollY || fd.documentElement?.scrollTop || fd.body?.scrollTop || 0;
        handleScrollDelta(dy, scrollY);
      }, { passive: true });

      fd.addEventListener('touchend', () => {
        lastTouchY = null;
      }, { passive: true });

      // 4. Mouse move near bottom edge (desktop wake zone)
      fd.addEventListener('mousemove', (e) => {
        const winH = fw.innerHeight || window.innerHeight;
        if (e.clientY >= winH - 32) {
          wakeRibbon();
        }
      }, { passive: true });

      // 5. Interaction inside frame resets idle timer
      fd.addEventListener('pointerdown', () => {
        if (!isRibbonHidden) {
          scheduleRibbonHide();
        }
      }, { passive: true });

    } catch (err) {
      console.warn('[Snuggle Shell] Could not attach frame scroll listener:', err);
    }
  }

  // ── Auto-Hide PiP Bottom Controls ──────────────
  const PIP_CONTROLS_HIDE_DELAY = 3500;
  let pipControlsHideTimer = null;
  let arePipControlsVisible = true;

  function showPipControls(autoHide = true) {
    clearTimeout(pipControlsHideTimer);
    arePipControlsVisible = true;
    snugglePip.classList.remove('controls-hidden');
    if (autoHide) {
      pipControlsHideTimer = setTimeout(() => {
        hidePipControls();
      }, PIP_CONTROLS_HIDE_DELAY);
    }
  }

  function hidePipControls() {
    clearTimeout(pipControlsHideTimer);
    arePipControlsVisible = false;
    snugglePip.classList.add('controls-hidden');
  }

  function schedulePipControlsHide(delay = PIP_CONTROLS_HIDE_DELAY) {
    clearTimeout(pipControlsHideTimer);
    pipControlsHideTimer = setTimeout(() => {
      hidePipControls();
    }, delay);
  }

  // ── Floating PiP Visibility & State ────────────
  function updatePipVisibility() {
    // Only show PiP when user is on the website tab AND (we are on call OR friend is in call) AND not dismissed
    if (activeTab === 'site' && (isCallActive || isFriendInCall) && !isPipDismissed) {
      snugglePip.hidden = false;
      updatePipStreams();
      showPipControls(true);
    } else {
      snugglePip.hidden = true;
      hidePipControls();
    }
  }

  function updatePipStreams() {
    // Remote video
    const vTracks = remoteStream ? remoteStream.getVideoTracks() : [];
    if (vTracks.length > 0) {
      pipRemoteVideo.srcObject = remoteStream;
      pipAvatarFallback.hidden = true;
      pipRemoteVideo.play().catch(() => {});
    } else {
      pipAvatarFallback.hidden = false;
    }

    // Local video inset
    if (localStream && localStream.getVideoTracks().length > 0 && !isCamOff) {
      pipLocalVideo.srcObject = localStream;
      pipLocalInset.hidden = false;
      pipLocalVideo.play().catch(() => {});
    } else {
      pipLocalInset.hidden = true;
    }

    // Show Join prompt if friend is calling and user hasn't joined call yet
    if (isFriendInCall && !isCallActive) {
      pipJoinPrompt.hidden = false;
    } else {
      pipJoinPrompt.hidden = true;
    }
  }

  // ── WebRTC & Media Initialization ──────────────
  async function initMedia(facingMode = 'user') {
    if (!checkSecureContext()) {
      return null;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      console.warn('[Snuggle Shell] mediaDevices not supported');
      if (permDialog) permDialog.hidden = false;
      showToast('Camera and microphone unavailable');
      setStatus('disconnected', 'Camera unavailable');
      return null;
    }

    try {
      const constraints = {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: {
          facingMode: { ideal: facingMode },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        }
      };

      localStream = await navigator.mediaDevices.getUserMedia(constraints);
      isCamOff = false;
      isMicMuted = false;

      // Assign local stream to stage & PiP
      stageLocalVideo.srcObject = localStream;
      pipLocalVideo.srcObject = localStream;
      if (localPlaceholder) localPlaceholder.hidden = true;
      pipLocalInset.hidden = false;

      checkCameraCount();

      // Attach tracks to PeerConnection
      if (pc && localStream) {
        localStream.getTracks().forEach(track => {
          const senders = pc.getSenders();
          const already = senders.some(s => s.track && s.track.id === track.id);
          if (!already) {
            pc.addTrack(track, localStream);
          }
        });
      }

      updateMicUI();
      updateCamUI();
      return localStream;
    } catch (err) {
      console.warn('[Snuggle Shell] Video+Audio failed, trying audio fallback:', err);
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stageLocalVideo.srcObject = null;
        pipLocalVideo.srcObject = null;
        if (localPlaceholder) localPlaceholder.hidden = false;
        pipLocalInset.hidden = true;
        isCamOff = true;
        updateCamUI();
        showToast('Connected with microphone only (camera off)');
        return localStream;
      } catch (audioErr) {
        console.error('[Snuggle Shell] Permission denied:', audioErr);
        if (permDialog) permDialog.hidden = false;
        showToast('Camera & microphone permission denied');
        setStatus('disconnected', 'Permission required');
        return null;
      }
    }
  }

  async function checkCameraCount() {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoInputs = devices.filter(d => d.kind === 'videoinput');
      if (videoInputs.length > 1) {
        hasMultipleCameras = true;
      }
    } catch (e) {}
  }

  // ── PeerConnection Setup ───────────────────────
  function createPeerConnection() {
    if (pc) {
      try { pc.close(); } catch (e) {}
    }

    pc = new RTCPeerConnection(RTC_CONFIG);
    if (!iceQueue) iceQueue = [];

    // Add local tracks if media is active
    if (localStream) {
      localStream.getTracks().forEach(track => {
        pc.addTrack(track, localStream);
      });
    }

    // Remote track arrived
    pc.ontrack = (event) => {
      console.log('[Snuggle Shell] Remote track arrived:', event.track.kind);
      
      if (event.streams && event.streams[0]) {
        remoteStream = event.streams[0];
      } else {
        if (!remoteStream) {
          remoteStream = new MediaStream();
        }
        const hasTrack = remoteStream.getTracks().some(t => t.id === event.track.id);
        if (!hasTrack) {
          remoteStream.addTrack(event.track);
        }
      }

      stageRemoteVideo.srcObject = remoteStream;
      pipRemoteVideo.srcObject = remoteStream;
      if (remoteAudio) remoteAudio.srcObject = remoteStream;

      setStatus('connected', 'Connected (P2P)');
      isFriendInCall = true;
      startCallTimer();
      setupAudioAnalysis();

      // When the video track is ready/unmuted, hide placeholder and play
      if (event.track.kind === 'video') {
        if (remotePlaceholder) remotePlaceholder.hidden = true;
        pipAvatarFallback.hidden = true;

        event.track.onunmute = () => {
          if (remotePlaceholder) remotePlaceholder.hidden = true;
          pipAvatarFallback.hidden = true;
          stageRemoteVideo.play().catch(() => {});
          pipRemoteVideo.play().catch(() => {});
        };

        event.track.onmute = () => {
          if (!remoteStream || !remoteStream.getVideoTracks().some(t => t.enabled && !t.muted)) {
            if (remotePlaceholder) remotePlaceholder.hidden = false;
            pipAvatarFallback.hidden = false;
          }
        };

        event.track.onended = () => {
          if (remotePlaceholder) remotePlaceholder.hidden = false;
          pipAvatarFallback.hidden = false;
        };
      }

      // Play video & audio feeds
      stageRemoteVideo.play().catch(() => {});
      pipRemoteVideo.play().catch(() => {});
      if (remoteAudio) remoteAudio.play().catch(() => {});

      updatePipStreams();
      updatePipVisibility();
      updateCallLobbyUI();
    };

    pc.onconnectionstatechange = () => {
      console.log('[Snuggle Shell] Connection State:', pc.connectionState);
      if (pc.connectionState === 'connected') {
        setStatus('connected', 'Connected (P2P)');
        const hasLiveVideo = remoteStream && remoteStream.getVideoTracks().some(t => t.readyState === 'live' && !t.muted);
        if (hasLiveVideo) {
          if (remotePlaceholder) remotePlaceholder.hidden = true;
          pipAvatarFallback.hidden = true;
        } else {
          if (remotePlaceholderText) remotePlaceholderText.textContent = 'Connected! Waiting for friend to start camera...';
        }
        isFriendInCall = true;
        startCallTimer();
        setupAudioAnalysis();
        updatePipVisibility();
        updateCallLobbyUI();
      } else if (pc.connectionState === 'disconnected') {
        setStatus('waiting', 'Reconnecting...');
      } else if (pc.connectionState === 'failed') {
        if (isFriendInCall && usersCount >= 2) {
          setStatus('disconnected', 'Connection failed');
        } else {
          setStatus('waiting', 'Waiting for friend to join...');
        }
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        const candStr = event.candidate.candidate || '';
        const parts = candStr.trim().split(/\s+/);
        // Only skip IPv6 host candidates (parts[7] is candidate type e.g. "host", parts[4] is address)
        // Never skip IPv4 host candidates (192.168.x.x) or mDNS candidates (.local)
        if (parts[7] === 'host' && parts[4] && parts[4].includes(':')) {
          return;
        }
        sendWS({
          type: 'webrtc_candidate',
          candidate: event.candidate,
          from: clientId
        });
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log('[Snuggle Shell] ICE State:', pc.iceConnectionState);
      switch (pc.iceConnectionState) {
        case 'connected':
        case 'completed':
          setStatus('connected', 'Connected (P2P)');
          const hasLiveVideo = remoteStream && remoteStream.getVideoTracks().some(t => t.readyState === 'live' && !t.muted);
          if (hasLiveVideo) {
            if (remotePlaceholder) remotePlaceholder.hidden = true;
            pipAvatarFallback.hidden = true;
          }
          isFriendInCall = true;
          updatePipVisibility();
          updateCallLobbyUI();
          break;
        case 'checking':
          setStatus('connecting', 'Connecting P2P...');
          break;
        case 'disconnected':
          setStatus('waiting', 'Reconnecting...');
          break;
        case 'failed':
          if (isFriendInCall && usersCount >= 2) {
            setStatus('disconnected', 'Connection failed');
            if (pc.restartIce) {
              pc.restartIce();
            }
          } else {
            setStatus('waiting', 'Waiting for friend to join...');
          }
          break;
      }
    };

    pc.onnegotiationneeded = async () => {
      try {
        if (makingOffer || pc.signalingState !== 'stable') return;
        makingOffer = true;
        await pc.setLocalDescription();
        sendWS({
          type: 'webrtc_offer',
          offer: pc.localDescription,
          from: clientId
        });
        console.log('[Snuggle Shell] Negotiation offer sent');
      } catch (err) {
        console.error('[Snuggle Shell] Negotiation error:', err);
      } finally {
        makingOffer = false;
      }
    };

    return pc;
  }

  async function initiateCall() {
    if (!pc) createPeerConnection();
    if (makingOffer || pc.signalingState !== 'stable') return;
    try {
      makingOffer = true;
      await pc.setLocalDescription();
      sendWS({
        type: 'webrtc_offer',
        offer: pc.localDescription,
        from: clientId
      });
      console.log('[Snuggle Shell] Offer sent');
    } catch (err) {
      console.error('[Snuggle Shell] Offer error:', err);
    } finally {
      makingOffer = false;
    }
  }

  function broadcastUserCountToFrame() {
    try {
      window.__snuggleUsersCount = usersCount;
      if (siteFrame && siteFrame.contentWindow) {
        siteFrame.contentWindow.postMessage({
          type: 'snuggle_users_count',
          usersCount: usersCount
        }, '*');
      }
    } catch (_) {}
  }

  // ── WebSocket Signaling ────────────────────────
  function connectWS() {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log('[Snuggle Shell] Signaling connected to room', ROOM_CODE);
      sendWS({ type: 'join_room', code: ROOM_CODE, from: clientId });

      clearInterval(pingInterval);
      pingInterval = setInterval(() => {
        sendWS({ type: 'ping' });
      }, 25000);

      // If user had an active call before reconnect, notify
      if (isCallActive) {
        sendWS({
          type: 'webrtc_status',
          from: clientId,
          status: 'ready',
          callActive: true
        });
      }
    };

    ws.onmessage = async (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) { return; }

      switch (msg.type) {
        case 'room_created':
        case 'room_joined':
          if (Array.isArray(msg.iceServers) && msg.iceServers.length > 0) {
            RTC_CONFIG.iceServers = msg.iceServers;
          }
          usersCount = msg.usersCount || 1;
          broadcastUserCountToFrame();
          if (msg.code) {
            ROOM_CODE = msg.code;
            sessionStorage.setItem('snuggle_room_code', ROOM_CODE);
            localStorage.setItem('snuggle_room_code', ROOM_CODE);
            if (callRoomCode) callRoomCode.textContent = ROOM_CODE;
          }
          if (window.snuggleTrack) {
            window.snuggleTrack(msg.type === 'room_created' ? 'room_create' : 'room_join', {
              roomCode: ROOM_CODE,
              usersCount: usersCount,
              section: 'shell'
            });
          }
          if (usersCount >= 2) {
            if (!isCallActive) {
              if (remotePlaceholderText) remotePlaceholderText.textContent = 'Friend is here in the room!';
            }
            sendWS({
              type: 'webrtc_status',
              from: clientId,
              status: 'ready',
              callActive: isCallActive
            });
          }
          break;

        case 'user_joined':
          if (msg.from && (msg.from === clientId || msg.from === sessionId)) return;
          usersCount = 2;
          broadcastUserCountToFrame();
          showToast('Friend joined the room');
          if (isCallActive) {
            sendWS({
              type: 'webrtc_status',
              from: clientId,
              status: 'ready',
              callActive: true
            });
            // If pc was waiting alone, restart connection to initiate clean offer to friend
            if (pc && pc.signalingState !== 'stable') {
              try { pc.close(); } catch (_) {}
              pc = null;
            }
            if (!pc) createPeerConnection();
            initiateCall();
          } else {
            updateCallLobbyUI();
          }
          break;

        case 'user_left':
          if (msg.from && (msg.from === clientId || msg.from === sessionId)) return;
          usersCount = 1;
          broadcastUserCountToFrame();
          showToast('Your friend left the room');
          isFriendInCall = false;
          resetRemoteView();
          updatePipVisibility();
          break;

        case 'webrtc_status':
          if (msg.from && msg.from !== clientId) {
            remoteClientId = msg.from;
            isPolite = clientId > remoteClientId;

            // Friend started or joined the call
            if (msg.callActive) {
              isFriendInCall = true;
              ribbonCallBadge.hidden = false;
              showRibbon(true);

              // Auto-launch PiP on website tab as requested!
              if (activeTab === 'site') {
                updatePipVisibility();
                showToast('Your friend started a video call!');
              } else {
                updateCallLobbyUI();
                showToast('Your friend is on video call! Tap to join 🎥');
              }

              if (!pc) createPeerConnection();
            } else if (msg.callActive === false) {
              isFriendInCall = false;
              resetRemoteView();
              updatePipVisibility();
              updateCallLobbyUI();
              ribbonCallBadge.hidden = true;
            }

            if (msg.status === 'ready' && !pc) {
              createPeerConnection();
            }

            if (typeof msg.audioMuted === 'boolean' && remoteMutedBadge) {
              remoteMutedBadge.hidden = !msg.audioMuted;
              remoteMutedBadge.closest('.video-badge--remote, .CallingAudioIndicator')?.classList.toggle('is-muted', msg.audioMuted);
            }

            if (typeof msg.videoOff === 'boolean') {
              if (msg.videoOff) {
                if (remotePlaceholder) remotePlaceholder.hidden = false;
                if (remotePlaceholderText) remotePlaceholderText.textContent = 'Friend turned off camera';
                pipAvatarFallback.hidden = false;
              } else {
                if (remoteStream && remoteStream.getVideoTracks().length > 0) {
                  if (remotePlaceholder) remotePlaceholder.hidden = true;
                  pipAvatarFallback.hidden = true;
                }
              }
            }
          }
          break;

        case 'webrtc_offer':
          if (msg.from === clientId) return;
          remoteClientId = msg.from;
          isPolite = clientId > remoteClientId;
          isFriendInCall = true;
          ribbonCallBadge.hidden = false;
          showRibbon(true);

          // Auto-launch PiP on website tab or update call lobby
          if (activeTab === 'site') {
            updatePipVisibility();
          } else {
            updateCallLobbyUI();
          }

          if (!pc) createPeerConnection();

          const offerCollision = (makingOffer || pc.signalingState !== 'stable');
          ignoreOffer = !isPolite && offerCollision;
          if (ignoreOffer) {
            console.log('[Snuggle Shell] Impolite peer ignoring colliding offer');
            return;
          }

          try {
            isSettingRemoteAnswerPending = false;
            if (offerCollision && isPolite) {
              console.log('[Snuggle Shell] Polite peer rolling back colliding offer');
              await pc.setLocalDescription({ type: 'rollback' });
            }
            await pc.setRemoteDescription(new RTCSessionDescription(msg.offer));
            while (iceQueue.length > 0) {
              const cand = iceQueue.shift();
              try { await pc.addIceCandidate(cand); } catch (e) {}
            }

            if (pc.signalingState === 'have-remote-offer') {
              await pc.setLocalDescription();
              sendWS({
                type: 'webrtc_answer',
                answer: pc.localDescription,
                from: clientId
              });
              console.log('[Snuggle Shell] Answer sent');
            }
          } catch (err) {
            console.error('[Snuggle Shell] Offer handling error:', err);
          }
          break;

        case 'webrtc_answer':
          if (msg.from === clientId || !pc) return;
          try {
            if (pc.signalingState === 'have-local-offer') {
              isSettingRemoteAnswerPending = true;
              await pc.setRemoteDescription(new RTCSessionDescription(msg.answer));
              isSettingRemoteAnswerPending = false;
              console.log('[Snuggle Shell] Remote answer accepted');

              while (iceQueue.length > 0) {
                const cand = iceQueue.shift();
                try { await pc.addIceCandidate(cand); } catch (e) {}
              }
            }
          } catch (err) {
            console.error('[Snuggle Shell] Answer error:', err);
          } finally {
            isSettingRemoteAnswerPending = false;
          }
          break;

        case 'webrtc_candidate':
          if (msg.from === clientId) return;
          if (msg.candidate) {
            try {
              let candObj = msg.candidate;
              // If candidate uses mDNS (.local) and sender LAN IP is known, resolve to direct IPv4
              if (candObj && candObj.candidate && candObj.candidate.includes('.local') && msg.senderIp && !msg.senderIp.includes(':')) {
                candObj.candidate = candObj.candidate.replace(/[a-zA-Z0-9-]+\.local/, msg.senderIp);
              }
              const candidate = new RTCIceCandidate(candObj);
              if (pc && pc.remoteDescription && pc.remoteDescription.type && !isSettingRemoteAnswerPending) {
                await pc.addIceCandidate(candidate);
              } else {
                iceQueue.push(candidate);
              }
            } catch (err) {
              if (!ignoreOffer) {
                console.warn('[Snuggle Shell] Candidate error:', err);
              }
            }
          }
          break;

        case 'room_invite':
          if (window.SnuggleInvite) window.SnuggleInvite.showInviteModal(msg);
          break;

        case 'error':
          if (msg.message === 'Room no longer exists') {
            showToast('Room expired, returning to home...');
            setTimeout(() => { window.location.href = '/'; }, 1500);
          }
          break;
      }
    };

    ws.onclose = () => {
      clearInterval(pingInterval);
      setStatus('disconnected', 'Reconnecting...');
      setTimeout(connectWS, 3000);
    };

    ws.onerror = (err) => {
      console.error('[Snuggle Shell] WS Error:', err);
    };
  }

  function sendWS(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      if (data && typeof data === 'object') {
        if (!data.sessionId) data.sessionId = sessionId;
        if (!data.from) data.from = clientId;
      }
      ws.send(JSON.stringify(data));
      return true;
    }
    return false;
  }

  function resetRemoteView() {
    remoteStream = null;
    stageRemoteVideo.srcObject = null;
    pipRemoteVideo.srcObject = null;
    if (remoteAudio) remoteAudio.srcObject = null;
    if (remotePlaceholder) remotePlaceholder.hidden = false;
    if (remotePlaceholderText) remotePlaceholderText.textContent = 'Waiting for friend to join...';
    if (remoteMutedBadge) {
      remoteMutedBadge.hidden = true;
      remoteMutedBadge.closest('.video-badge--remote, .CallingAudioIndicator')?.classList.remove('is-muted');
    }
    pipAvatarFallback.hidden = false;
    if (pc) {
      try { pc.close(); } catch (e) {}
      pc = null;
    }
    updateCallLobbyUI();
  }

  // ── Call Lobby & Stage Action UI Helper ────────
  function updateCallLobbyUI() {
    const btnText = $('btn-start-call-text');
    const title = $('call-idle-title');
    const desc = $('call-idle-desc');
    if (!isCallActive) {
      if (callIdleActions) callIdleActions.hidden = false;
      if (isFriendInCall) {
        if (title) title.textContent = 'Friend is Calling';
        if (desc) desc.textContent = 'Your friend is on video call. Join now to see and talk with them!';
        if (btnText) btnText.textContent = 'Join Video Call';
        setStatus('waiting', 'Friend is on call');
      } else {
        if (title) title.textContent = 'Snuggle Video Call';
        if (desc) desc.textContent = 'Stay connected on video while watching movies and playing games in this room.';
        if (btnText) btnText.textContent = 'Start Video Call';
      }
    } else {
      if (callIdleActions) callIdleActions.hidden = true;
    }
  }

  // ── Audio Context Unlock for Mobile ───────────
  function unlockAudio() {
    if (remoteAudio && remoteAudio.paused) {
      remoteAudio.play().catch(() => {});
    }
  }

  // ── Start / Join Call Action ───────────────────
  async function startCall() {
    if (!checkSecureContext()) {
      return;
    }
    unlockAudio();

    isCallActive = true;
    isPipDismissed = false;
    updateCallLobbyUI();
    setStatus('connecting', 'Starting camera & mic...');

    const stream = await initMedia();
    if (!stream) {
      isCallActive = false;
      updateCallLobbyUI();
      return;
    }

    if (!pc) createPeerConnection();

    // If pc is already connected with remote peer
    if (pc.connectionState === 'connected' || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
      setStatus('connected', 'Connected (P2P)');
      const hasLiveVideo = remoteStream && remoteStream.getVideoTracks().some(t => t.readyState === 'live' && !t.muted);
      if (hasLiveVideo) {
        if (remotePlaceholder) remotePlaceholder.hidden = true;
        pipAvatarFallback.hidden = true;
      }
      isFriendInCall = true;
      startCallTimer();
      setupAudioAnalysis();
      // Renegotiate so our new local tracks are sent to the friend
      initiateCall();
    } else if (usersCount >= 2 || isFriendInCall) {
      setStatus('connecting', 'Connecting with friend...');
      initiateCall();
    } else {
      setStatus('waiting', 'Waiting for friend to join...');
      if (remotePlaceholderText) remotePlaceholderText.textContent = 'Waiting for friend to join...';
    }

    sendWS({
      type: 'webrtc_status',
      from: clientId,
      status: 'ready',
      callActive: true
    });

    updatePipVisibility();
    showToast('Joined video call 🎥');
    if (window.snuggleTrack) {
      window.snuggleTrack('call_start', { roomCode: ROOM_CODE });
    }
  }

  // ── End / Hang Up Call Action ──────────────────
  function endCall() {
    const elapsedSec = callStartTime ? Math.round((Date.now() - callStartTime) / 1000) : 0;
    if (window.snuggleTrack) {
      window.snuggleTrack('call_end', { roomCode: ROOM_CODE, durationSec: elapsedSec });
    }
    isCallActive = false;
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
    }

    stageLocalVideo.srcObject = null;
    pipLocalVideo.srcObject = null;
    pipLocalInset.hidden = true;
    if (localPlaceholder) localPlaceholder.hidden = false;

    if (pc) {
      try { pc.close(); } catch (e) {}
      pc = null;
    }

    sendWS({
      type: 'webrtc_status',
      from: clientId,
      status: 'idle',
      callActive: false
    });

    stopCallTimer();
    teardownAudioAnalysis();

    // Reset Stage UI to clean Start Call screen
    updateCallLobbyUI();
    if (remotePlaceholder) remotePlaceholder.hidden = false;
    if (remotePlaceholderText) remotePlaceholderText.textContent = 'Call ended. Start again anytime!';
    setStatus('idle', 'Call ended');

    // Hide PiP overlay
    updatePipVisibility();
    showToast('Left video call');
  }

  // ── Controls: Mic / Cam / Swap / Flip ──────────
  function toggleMic() {
    if (!isCallActive) {
      startCall();
      return;
    }
    isMicMuted = !isMicMuted;
    if (localStream) {
      const audioTrack = localStream.getAudioTracks()[0];
      if (audioTrack) audioTrack.enabled = !isMicMuted;
    }
    updateMicUI();
    sendWS({
      type: 'webrtc_status',
      from: clientId,
      audioMuted: isMicMuted
    });
    showToast(isMicMuted ? 'Microphone muted' : 'Microphone unmuted');
  }

  function updateMicUI() {
    if (ctrlMic) {
      ctrlMic.classList.toggle('ctrl-btn__icon--off', isMicMuted);
      if (isMicMuted) {
        if (iconMicOn) iconMicOn.hidden = true;
        if (iconMicOff) iconMicOff.hidden = false;
        ctrlMic.querySelector('.ctrl-btn__icon')?.classList.add('ctrl-btn__icon--off');
        ctrlMic.querySelector('.ctrl-btn__label') && (ctrlMic.querySelector('.ctrl-btn__label').textContent = 'Unmute');
      } else {
        if (iconMicOn) iconMicOn.hidden = false;
        if (iconMicOff) iconMicOff.hidden = true;
        ctrlMic.querySelector('.ctrl-btn__icon')?.classList.remove('ctrl-btn__icon--off');
        ctrlMic.querySelector('.ctrl-btn__label') && (ctrlMic.querySelector('.ctrl-btn__label').textContent = 'Mute');
      }
    }

    // PiP mic button
    if (pipCtrlMic) {
      if (isMicMuted) {
        pipCtrlMic.classList.add('is-active-off');
        if (pipIconMicOn) pipIconMicOn.hidden = true;
        if (pipIconMicOff) pipIconMicOff.hidden = false;
      } else {
        pipCtrlMic.classList.remove('is-active-off');
        if (pipIconMicOn) pipIconMicOn.hidden = false;
        if (pipIconMicOff) pipIconMicOff.hidden = true;
      }
    }
  }

  function toggleCam() {
    if (!isCallActive) {
      startCall();
      return;
    }
    isCamOff = !isCamOff;
    if (localStream) {
      const videoTrack = localStream.getVideoTracks()[0];
      if (videoTrack) videoTrack.enabled = !isCamOff;
    }
    if (localPlaceholder) localPlaceholder.hidden = !isCamOff;
    pipLocalInset.hidden = isCamOff;
    updateCamUI();
    sendWS({
      type: 'webrtc_status',
      from: clientId,
      videoOff: isCamOff
    });
    showToast(isCamOff ? 'Camera turned off' : 'Camera turned on');
  }

  function updateCamUI() {
    if (ctrlCam) {
      ctrlCam.classList.toggle('ctrl-btn__icon--off', isCamOff);
      if (isCamOff) {
        if (iconCamOn) iconCamOn.hidden = true;
        if (iconCamOff) iconCamOff.hidden = false;
        ctrlCam.querySelector('.ctrl-btn__icon')?.classList.add('ctrl-btn__icon--off');
        ctrlCam.querySelector('.ctrl-btn__label') && (ctrlCam.querySelector('.ctrl-btn__label').textContent = 'Start Cam');
      } else {
        if (iconCamOn) iconCamOn.hidden = false;
        if (iconCamOff) iconCamOff.hidden = true;
        ctrlCam.querySelector('.ctrl-btn__icon')?.classList.remove('ctrl-btn__icon--off');
        ctrlCam.querySelector('.ctrl-btn__label') && (ctrlCam.querySelector('.ctrl-btn__label').textContent = 'Camera');
      }
    }
  }

  async function switchCamera() {
    if (!localStream) {
      showToast('Start call to flip camera');
      return;
    }
    const currentVideoTrack = localStream.getVideoTracks()[0];
    if (!currentVideoTrack) {
      showToast('Camera is off');
      return;
    }
    try {
      const targetFacing = currentFacingMode === 'user' ? 'environment' : 'user';
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: targetFacing } }
      });
      const newTrack = newStream.getVideoTracks()[0];
      if (!newTrack) {
        showToast('No other camera found');
        return;
      }
      currentFacingMode = targetFacing;

      const oldTrack = localStream.getVideoTracks()[0];
      if (oldTrack) {
        oldTrack.stop();
        localStream.removeTrack(oldTrack);
      }
      localStream.addTrack(newTrack);

      if (currentFacingMode === 'environment') {
        stageLocalVideo.style.transform = 'none';
        pipLocalVideo.style.transform = 'none';
      } else {
        stageLocalVideo.style.transform = '';
        pipLocalVideo.style.transform = '';
      }

      stageLocalVideo.srcObject = localStream;
      pipLocalVideo.srcObject = localStream;

      if (pc) {
        const senders = pc.getSenders();
        const vSender = senders.find(s => s.track && s.track.kind === 'video');
        if (vSender) await vSender.replaceTrack(newTrack);
      }
      if (ctrlSwitchCam) {
        ctrlSwitchCam.classList.toggle('is-flipped', currentFacingMode === 'environment');
      }
      showToast(currentFacingMode === 'user' ? 'Front camera' : 'Back camera');
    } catch (e) {
      console.warn('[Snuggle Shell] Switch camera error:', e);
      showToast('Could not switch camera');
    }
  }

  function toggleSwap() {
    if (callStage) callStage.classList.toggle('is-swapped');
  }

  async function shareRoom() {
    if (usersCount > 1) {
      if (window.SnuggleInvite && window.SnuggleInvite.markInviteSent) window.SnuggleInvite.markInviteSent();
      sendWS({
        type: 'room_invite',
        activity: 'Video Call',
        url: `${window.location.origin}/room?code=${ROOM_CODE}&tab=call`,
        from: clientId,
        senderId: clientId
      });
      showToast('Invite sent to friend!');
      return;
    }

    const host = window.location.hostname;
    const shareHost = (host === 'localhost' || host === '127.0.0.1') ? '192.168.1.8' : host;
    let sectionPath = window.location.pathname;
    if (sectionPath === '/room' || sectionPath === '/room.html' || sectionPath === '/') {
      sectionPath = '/home';
    }
    const directUrl = `https://${shareHost}:3443${sectionPath}?code=${encodeURIComponent(ROOM_CODE)}`;

    if (shareModal && shareQrImg && shareModalCode) {
      shareModalCode.textContent = ROOM_CODE;
      shareQrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(directUrl)}`;
      shareModal.hidden = false;
      return;
    }

    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Join my Snuggle Video Call',
          text: `Join room ${ROOM_CODE} on Snuggle:`,
          url: directUrl
        });
        return;
      } catch (e) {}
    }

    try {
      await navigator.clipboard.writeText(directUrl);
    } catch (e) {
      const t = document.createElement('textarea');
      t.value = directUrl;
      t.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(t);
      t.select();
      document.execCommand('copy');
      t.remove();
    }

    if (callRoomPill) {
      callRoomPill.classList.add('copied');
      showToast('Room link copied!');
      setTimeout(() => callRoomPill.classList.remove('copied'), 2000);
    }
  }

  // ── Draggable & Resizable Floating PiP Engine ──
  function setupDraggablePip() {
    let isDragging = false;
    let isResizing = false;
    let isPinching = false;
    let pinchJustEnded = false;
    let resizeDir = null;

    let startX = 0;
    let startY = 0;
    let initialLeft = 0;
    let initialTop = 0;
    let initialWidth = 0;
    let initialHeight = 0;
    let activePointerId = null;

    // Mobile pinch tracking
    let initialPinchDist = 0;
    let initialPinchW = 0;
    let initialPinchH = 0;
    let initialPinchL = 0;
    let initialPinchT = 0;
    let initialPinchCenter = { x: 0, y: 0 };

    const cursorMap = {
      n: 'ns-resize',
      s: 'ns-resize',
      w: 'ew-resize',
      e: 'ew-resize',
      nw: 'nwse-resize',
      se: 'nwse-resize',
      ne: 'nesw-resize',
      sw: 'nesw-resize'
    };

    // Restore saved custom dimensions
    applySavedPipSize();

    // Load saved or default position
    const savedPos = localStorage.getItem('snuggle_pip_pos');
    if (savedPos) {
      try {
        const pos = JSON.parse(savedPos);
        clampAndSetPipPosition(pos.x, pos.y);
      } catch (e) {
        setDefaultPipPosition();
      }
    } else {
      setDefaultPipPosition();
    }

    function applySavedPipSize() {
      const savedSize = localStorage.getItem('snuggle_pip_size');
      if (savedSize) {
        try {
          const size = JSON.parse(savedSize);
          if (size && typeof size.w === 'number' && typeof size.h === 'number') {
            const minW = 120;
            const maxW = Math.max(minW, window.innerWidth - 16);
            const minH = 160;
            const maxH = Math.max(minH, window.innerHeight - 80);
            const clampedW = Math.min(Math.max(size.w, minW), maxW);
            const clampedH = Math.min(Math.max(size.h, minH), maxH);
            snugglePip.style.width = `${clampedW}px`;
            snugglePip.style.height = `${clampedH}px`;
          }
        } catch (_) {}
      }
    }

    function setDefaultPipPosition() {
      const margin = 16;
      const ribbonHeight = 68;
      const pipW = snugglePip.offsetWidth || 168;
      const pipH = snugglePip.offsetHeight || 246;
      const x = window.innerWidth - pipW - margin;
      const y = window.innerHeight - pipH - ribbonHeight;
      clampAndSetPipPosition(x, y);
    }

    function clampPipDimensions() {
      const maxW = Math.max(120, window.innerWidth - 16);
      const maxH = Math.max(160, window.innerHeight - 80);
      if (snugglePip.offsetWidth > maxW) snugglePip.style.width = `${maxW}px`;
      if (snugglePip.offsetHeight > maxH) snugglePip.style.height = `${maxH}px`;
    }

    function clampAndSetPipPosition(targetX, targetY) {
      clampPipDimensions();
      const minX = 8;
      const maxX = Math.max(minX, window.innerWidth - (snugglePip.offsetWidth || 168) - 8);
      const minY = 8;
      const ribbonH = isRibbonHidden ? 10 : 68;
      const maxY = Math.max(minY, window.innerHeight - (snugglePip.offsetHeight || 246) - ribbonH);

      const clampedX = Math.min(Math.max(targetX, minX), maxX);
      const clampedY = Math.min(Math.max(targetY, minY), maxY);

      snugglePip.style.left = `${clampedX}px`;
      snugglePip.style.top = `${clampedY}px`;
      snugglePip.style.right = 'auto';
      snugglePip.style.bottom = 'auto';

      localStorage.setItem('snuggle_pip_pos', JSON.stringify({ x: clampedX, y: clampedY }));
    }

    // Determine if pointer is on an explicit handle or near a boundary edge
    function getResizeEdge(e) {
      // 1. Explicit resizer element handle
      const resizer = e.target.closest('.pip-resizer');
      if (resizer && resizer.dataset.direction) {
        return resizer.dataset.direction;
      }

      // Do not treat interactive buttons as resize edges
      if (e.target.closest('button')) return null;

      // 2. Cursor coordinate proximity to edge (within 9px of outer border)
      const rect = snugglePip.getBoundingClientRect();
      const EDGE = 9;
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const nearLeft = x >= 0 && x <= EDGE;
      const nearRight = x >= rect.width - EDGE && x <= rect.width;
      const nearTop = y >= 0 && y <= EDGE;
      const nearBottom = y >= rect.height - EDGE && y <= rect.height;

      if (nearTop && nearLeft) return 'nw';
      if (nearTop && nearRight) return 'ne';
      if (nearBottom && nearLeft) return 'sw';
      if (nearBottom && nearRight) return 'se';
      if (nearTop) return 'n';
      if (nearBottom) return 's';
      if (nearLeft) return 'w';
      if (nearRight) return 'e';

      return null;
    }

    // Dynamic hover cursor for desktop edge dragging & controls wake
    snugglePip.addEventListener('pointerenter', () => {
      showPipControls(true);
    });

    snugglePip.addEventListener('pointermove', (e) => {
      showPipControls(true);
      if (isDragging || isResizing || isPinching) return;
      if (e.pointerType === 'mouse') {
        const edge = getResizeEdge(e);
        snugglePip.style.cursor = edge ? cursorMap[edge] : '';
      }
    });

    snugglePip.addEventListener('pointerleave', () => {
      if (!isResizing && !isDragging) {
        snugglePip.style.cursor = '';
        schedulePipControlsHide(PIP_CONTROLS_HIDE_DELAY);
      }
    });

    // Pointer event dragging & desktop edge resizing
    function onPointerDown(e) {
      showPipControls(true);
      if (pinchJustEnded || isPinching) return;
      if (e.target.closest('button')) return;
      if (e.button !== undefined && e.button !== 0) return;

      const edge = getResizeEdge(e);
      if (edge) {
        // Desktop edge resize start
        isResizing = true;
        resizeDir = edge;
        activePointerId = e.pointerId;
        snugglePip.setPointerCapture(e.pointerId);

        startX = e.clientX;
        startY = e.clientY;
        initialLeft = snugglePip.offsetLeft;
        initialTop = snugglePip.offsetTop;
        initialWidth = snugglePip.offsetWidth;
        initialHeight = snugglePip.offsetHeight;

        snugglePip.classList.add('is-resizing');
        document.body.classList.add('is-pip-resizing');
        document.body.style.cursor = cursorMap[edge] || 'default';
        return;
      }

      // Normal drag-to-move start
      activePointerId = e.pointerId;
      snugglePip.setPointerCapture(e.pointerId);

      startX = e.clientX;
      startY = e.clientY;
      initialLeft = snugglePip.offsetLeft;
      initialTop = snugglePip.offsetTop;
      isDragging = false;

      snugglePip.classList.add('is-dragging');
      document.body.classList.add('is-pip-dragging');
    }

    function onPointerMove(e) {
      if (activePointerId === null || e.pointerId !== activePointerId) return;

      clearTimeout(pipControlsHideTimer);
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      if (isResizing) {
        const minW = 120;
        const maxW = Math.min(window.innerWidth - 16, 560);
        const minH = 160;
        const maxH = Math.min(window.innerHeight - 80, 720);
        const minX = 8;
        const maxX = window.innerWidth - 8;
        const minY = 8;
        const maxY = window.innerHeight - 68;

        let newW = initialWidth;
        let newH = initialHeight;
        let newL = initialLeft;
        let newT = initialTop;

        // Horizontal resizing
        if (resizeDir.includes('e')) {
          newW = Math.min(Math.max(initialWidth + dx, minW), maxW);
          if (newL + newW > maxX) {
            newW = maxX - newL;
          }
        } else if (resizeDir.includes('w')) {
          const rawW = initialWidth - dx;
          newW = Math.min(Math.max(rawW, minW), maxW);
          newL = initialLeft + (initialWidth - newW);
          if (newL < minX) {
            newL = minX;
            newW = (initialLeft + initialWidth) - minX;
          }
        }

        // Vertical resizing
        if (resizeDir.includes('s')) {
          newH = Math.min(Math.max(initialHeight + dy, minH), maxH);
          if (newT + newH > maxY) {
            newH = maxY - newT;
          }
        } else if (resizeDir.includes('n')) {
          const rawH = initialHeight - dy;
          newH = Math.min(Math.max(rawH, minH), maxH);
          newT = initialTop + (initialHeight - newH);
          if (newT < minY) {
            newT = minY;
            newH = (initialTop + initialHeight) - minY;
          }
        }

        snugglePip.style.width = `${Math.round(newW)}px`;
        snugglePip.style.height = `${Math.round(newH)}px`;
        snugglePip.style.left = `${Math.round(newL)}px`;
        snugglePip.style.top = `${Math.round(newT)}px`;
        return;
      }

      // Normal drag-to-move
      if (!isDragging && Math.hypot(dx, dy) > 5) {
        isDragging = true;
      }

      if (isDragging) {
        clampAndSetPipPosition(initialLeft + dx, initialTop + dy);
      }
    }

    function onPointerUp(e) {
      if (activePointerId === null || e.pointerId !== activePointerId) return;
      try { snugglePip.releasePointerCapture(e.pointerId); } catch (_) {}
      activePointerId = null;

      if (isResizing) {
        isResizing = false;
        resizeDir = null;
        snugglePip.classList.remove('is-resizing');
        document.body.classList.remove('is-pip-resizing');
        document.body.style.cursor = '';
        snugglePip.style.cursor = '';

        localStorage.setItem('snuggle_pip_size', JSON.stringify({
          w: snugglePip.offsetWidth,
          h: snugglePip.offsetHeight
        }));
        localStorage.setItem('snuggle_pip_pos', JSON.stringify({
          x: snugglePip.offsetLeft,
          y: snugglePip.offsetTop
        }));
        clampAndSetPipPosition(snugglePip.offsetLeft, snugglePip.offsetTop);
        showPipControls(true);
        return;
      }

      snugglePip.classList.remove('is-dragging');
      document.body.classList.remove('is-pip-dragging');

      if (pinchJustEnded) {
        pinchJustEnded = false;
        isDragging = false;
        showPipControls(true);
        return;
      }

      if (isDragging) {
        // Stay wherever the user puts it instead of going to one of the sides
        clampAndSetPipPosition(snugglePip.offsetLeft, snugglePip.offsetTop);
        showPipControls(true);
      } else {
        // Tapped without dragging
        const target = e.target;
        if (target.closest('#pip-video-click-area')) {
          if (!arePipControlsVisible) {
            showPipControls(true);
          } else {
            switchTab('call');
          }
        }
      }
      isDragging = false;
    }

    // Mobile Pinch-to-Resize with 2 fingers
    snugglePip.addEventListener('touchstart', (e) => {
      showPipControls(true);
      if (e.touches.length === 2) {
        isPinching = true;

        if (activePointerId !== null) {
          try { snugglePip.releasePointerCapture(activePointerId); } catch (_) {}
          activePointerId = null;
        }
        isDragging = false;
        snugglePip.classList.remove('is-dragging');
        document.body.classList.remove('is-pip-dragging');

        snugglePip.classList.add('is-resizing');
        document.body.classList.add('is-pip-resizing');

        const t0 = e.touches[0];
        const t1 = e.touches[1];
        initialPinchDist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
        initialPinchW = snugglePip.offsetWidth;
        initialPinchH = snugglePip.offsetHeight;
        initialPinchL = snugglePip.offsetLeft;
        initialPinchT = snugglePip.offsetTop;
        initialPinchCenter = {
          x: (t0.clientX + t1.clientX) / 2,
          y: (t0.clientY + t1.clientY) / 2
        };
      }
    }, { passive: false });

    snugglePip.addEventListener('touchmove', (e) => {
      if (isPinching && e.touches.length >= 2) {
        if (e.cancelable) e.preventDefault();

        const t0 = e.touches[0];
        const t1 = e.touches[1];
        const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
        if (initialPinchDist < 10) return;

        const scale = dist / initialPinchDist;

        const minW = 120;
        const maxW = Math.min(window.innerWidth - 16, 480);
        const minH = 160;
        const maxH = Math.min(window.innerHeight - 80, 680);

        let targetW = initialPinchW * scale;
        let targetH = initialPinchH * scale;

        // Maintain aspect ratio proportionally while pinching
        if (targetW < minW) {
          targetW = minW;
          targetH = initialPinchH * (minW / initialPinchW);
        } else if (targetW > maxW) {
          targetW = maxW;
          targetH = initialPinchH * (maxW / initialPinchW);
        }

        if (targetH < minH) {
          targetH = minH;
          targetW = initialPinchW * (minH / initialPinchH);
        } else if (targetH > maxH) {
          targetH = maxH;
          targetW = initialPinchW * (maxH / initialPinchH);
        }

        targetW = Math.round(targetW);
        targetH = Math.round(targetH);

        // Zoom outward/inward anchored to the pinch center point
        const relX = (initialPinchCenter.x - initialPinchL) / (initialPinchW || 1);
        const relY = (initialPinchCenter.y - initialPinchT) / (initialPinchH || 1);

        const widthDiff = targetW - initialPinchW;
        const heightDiff = targetH - initialPinchH;

        let targetL = Math.round(initialPinchL - widthDiff * relX);
        let targetT = Math.round(initialPinchT - heightDiff * relY);

        const minX = 8;
        const maxX = Math.max(minX, window.innerWidth - targetW - 8);
        const minY = 8;
        const maxY = Math.max(minY, window.innerHeight - targetH - 68);

        targetL = Math.min(Math.max(targetL, minX), maxX);
        targetT = Math.min(Math.max(targetT, minY), maxY);

        snugglePip.style.width = `${targetW}px`;
        snugglePip.style.height = `${targetH}px`;
        snugglePip.style.left = `${targetL}px`;
        snugglePip.style.top = `${targetT}px`;
      }
    }, { passive: false });

    snugglePip.addEventListener('touchend', (e) => {
      if (isPinching) {
        if (e.touches.length < 2) {
          isPinching = false;
          snugglePip.classList.remove('is-resizing');
          document.body.classList.remove('is-pip-resizing');

          localStorage.setItem('snuggle_pip_size', JSON.stringify({
            w: snugglePip.offsetWidth,
            h: snugglePip.offsetHeight
          }));
          localStorage.setItem('snuggle_pip_pos', JSON.stringify({
            x: snugglePip.offsetLeft,
            y: snugglePip.offsetTop
          }));

          pinchJustEnded = true;
          setTimeout(() => {
            pinchJustEnded = false;
          }, 350);
          showPipControls(true);
        }
      } else {
        showPipControls(true);
      }
    });

    snugglePip.addEventListener('touchcancel', () => {
      if (isPinching) {
        isPinching = false;
        snugglePip.classList.remove('is-resizing');
        document.body.classList.remove('is-pip-resizing');
      }
      showPipControls(true);
    });

    snugglePip.addEventListener('pointerdown', onPointerDown);
    snugglePip.addEventListener('pointermove', onPointerMove);
    snugglePip.addEventListener('pointerup', onPointerUp);
    snugglePip.addEventListener('pointercancel', onPointerUp);

    window.addEventListener('resize', () => {
      clampAndSetPipPosition(snugglePip.offsetLeft, snugglePip.offsetTop);
    });
  }

  // ── Event Listeners Setup ──────────────────────
  function setupListeners() {
    // Bottom Ribbon Tabs
    tabCall.addEventListener('click', () => switchTab('call'));
    tabSite.addEventListener('click', () => switchTab('site'));

    // Call Stage Back Button
    if (callTabBackBtn) {
      callTabBackBtn.addEventListener('click', () => switchTab('site'));
    }

    // Call Action Buttons
    if (btnStartCall) btnStartCall.addEventListener('click', startCall);
    if (ctrlMic) ctrlMic.addEventListener('click', toggleMic);
    if (ctrlCam) ctrlCam.addEventListener('click', toggleCam);
    if (ctrlSwitchCam) ctrlSwitchCam.addEventListener('click', switchCamera);
    if (ctrlSwap) ctrlSwap.addEventListener('click', toggleSwap);
    if (localContainer) localContainer.addEventListener('click', () => {
      if (!callStage || !callStage.classList.contains('is-swapped')) {
        toggleSwap();
      }
    });
    if (remoteContainer) remoteContainer.addEventListener('click', () => {
      if (callStage && callStage.classList.contains('is-swapped')) {
        toggleSwap();
      }
    });
    if (ctrlLeave) ctrlLeave.addEventListener('click', endCall);
    if (callRoomPill) callRoomPill.addEventListener('click', shareRoom);

    // Remote Video Frame Render Listeners
    const onRemoteVideoPlaying = () => {
      if (remotePlaceholder) remotePlaceholder.hidden = true;
      if (pipAvatarFallback) pipAvatarFallback.hidden = true;
    };
    if (stageRemoteVideo) {
      stageRemoteVideo.addEventListener('loadedmetadata', onRemoteVideoPlaying);
      stageRemoteVideo.addEventListener('playing', onRemoteVideoPlaying);
    }
    if (pipRemoteVideo) {
      pipRemoteVideo.addEventListener('loadedmetadata', onRemoteVideoPlaying);
      pipRemoteVideo.addEventListener('playing', onRemoteVideoPlaying);
    }

    // PiP Action Buttons: 1. mic, 2. full screen, 3. remove pip
    if (pipCtrlMic) {
      pipCtrlMic.addEventListener('click', () => {
        showPipControls(true);
        toggleMic();
      });
    }
    if (pipCtrlExpand) pipCtrlExpand.addEventListener('click', () => switchTab('call'));
    if (pipCtrlClose) pipCtrlClose.addEventListener('click', dismissPip);
    if (pipJoinBtn) pipJoinBtn.addEventListener('click', startCall);

    // Permission Dialog retry button
    if (btnRetryPerm) {
      btnRetryPerm.addEventListener('click', async () => {
        if (permDialog) permDialog.hidden = true;
        await startCall();
      });
    }

    // Share Modal listeners
    if (btnCloseShareModal) {
      btnCloseShareModal.addEventListener('click', () => {
        if (shareModal) shareModal.hidden = true;
      });
    }

    if (btnCopyShareUrl) {
      btnCopyShareUrl.addEventListener('click', async () => {
        const host = window.location.hostname;
        const shareHost = (host === 'localhost' || host === '127.0.0.1') ? '192.168.1.8' : host;
        let sectionPath = window.location.pathname;
        if (sectionPath === '/room' || sectionPath === '/room.html' || sectionPath === '/') {
          sectionPath = '/home';
        }
        const directUrl = `https://${shareHost}:3443${sectionPath}?code=${encodeURIComponent(ROOM_CODE)}`;
        try {
          await navigator.clipboard.writeText(directUrl);
          showToast('Copied room link!');
        } catch (_) {
          showToast(`Room: ${ROOM_CODE}`);
        }
      });
    }

    // Call Stage Tapping toggles controls (Signal style)
    if (callStage) {
      callStage.addEventListener('click', (e) => {
        if (e.target.closest('button') || e.target.closest('#local-container')) return;
        toggleControls();
      });
    }

    // Pointer move / touch on callSection wakes controls up
    if (callSection) {
      const wakeControls = () => {
        if (!areControlsVisible) {
          showControls(true);
        } else {
          clearTimeout(controlsHideTimer);
          controlsHideTimer = setTimeout(hideControls, 3500);
        }
      };

      callSection.addEventListener('pointermove', wakeControls);
      callSection.addEventListener('touchstart', wakeControls, { passive: true });
    }

    // Unlock audio context on initial interaction (mobile browsers)
    document.addEventListener('click', unlockAudio, { once: true });
    document.addEventListener('touchstart', unlockAudio, { once: true, passive: true });

    // Keyboard shortcut for reload
    window.addEventListener('keydown', handleRefreshKey, true);

    // Ribbon Hover & Interaction
    if (snuggleRibbon) {
      snuggleRibbon.addEventListener('pointerenter', () => {
        isRibbonHovered = true;
        clearTimeout(ribbonHideTimer);
      });
      snuggleRibbon.addEventListener('pointerleave', () => {
        isRibbonHovered = false;
        scheduleRibbonHide();
      });
    }

    // Peek Trigger Pill
    if (ribbonPeekPill) {
      ribbonPeekPill.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showRibbon(true);
      });
      ribbonPeekPill.addEventListener('pointerenter', () => {
        showRibbon(true);
      });
    }

    // Top Window Wheel, Touch, and Mouse for Outer Shell
    window.addEventListener('wheel', (e) => {
      handleScrollDelta(e.deltaY, 999);
    }, { passive: true });

    let shellTouchStartY = null;
    let shellLastTouchY = null;
    window.addEventListener('touchstart', (e) => {
      if (e.touches && e.touches.length === 1) {
        shellTouchStartY = e.touches[0].clientY;
        shellLastTouchY = shellTouchStartY;
      }
    }, { passive: true });

    window.addEventListener('touchmove', (e) => {
      if (shellLastTouchY === null || !e.touches || e.touches.length !== 1) return;
      const currentY = e.touches[0].clientY;
      const dy = shellLastTouchY - currentY;
      shellLastTouchY = currentY;
      handleScrollDelta(dy, 999);
    }, { passive: true });

    window.addEventListener('touchend', () => {
      shellTouchStartY = null;
      shellLastTouchY = null;
    }, { passive: true });

    window.addEventListener('mousemove', (e) => {
      if (e.clientY >= window.innerHeight - 32) {
        wakeRibbon();
      }
    }, { passive: true });

    attachScrollListenersToFrame();

    // Schedule initial hide after orientation delay (4s)
    scheduleRibbonHide(4000);

    // Frame load listener for URL synchronization and key capture
    if (siteFrame) {
      siteFrame.addEventListener('load', onFrameLoaded);
    }

    // Browser Back / Forward navigation listener
    window.addEventListener('popstate', onPopState);

    // Setup Draggable behavior for PiP
    setupDraggablePip();

    // Fullscreen synchronization to keep PiP visible and update stage/ribbon
    const onFullscreenChange = () => {
      const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
      if (isFs) {
        hideRibbon();
      } else {
        try {
          const frameWin = siteFrame && siteFrame.contentWindow;
          const frameDoc = siteFrame && (siteFrame.contentDocument || frameWin?.document);
          if (frameDoc) {
            const pseudoEls = frameDoc.querySelectorAll('.pseudo-fullscreen, .gp--pseudo');
            pseudoEls.forEach(el => {
              el.classList.remove('pseudo-fullscreen');
              el.classList.remove('gp--pseudo');
            });
            frameDoc.dispatchEvent(new Event('fullscreenchange'));
            if (frameWin) frameWin.dispatchEvent(new Event('resize'));
          }
        } catch (_) {}
      }
      clampAndSetPipPosition(snugglePip.offsetLeft, snugglePip.offsetTop);
    };

    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    hookFrameFullscreen();
  }

  // ── In-App Section Reload & Keyboard Shortcuts ──
  function reloadSection() {
    if (!siteFrame) return;

    try {
      if (siteFrame.contentWindow) {
        siteFrame.contentWindow.location.reload();
      } else {
        siteFrame.src = siteFrame.src;
      }
    } catch (_) {
      siteFrame.src = siteFrame.src;
    }
  }

  function handleRefreshKey(e) {
    if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'R'))) {
      e.preventDefault();
      reloadSection();
    }
  }

  function attachKeyHandlerToFrame() {
    try {
      const frameWin = siteFrame && siteFrame.contentWindow;
      if (!frameWin || frameWin.__snuggleKeyAttached) return;
      frameWin.__snuggleKeyAttached = true;
      frameWin.addEventListener('keydown', handleRefreshKey, true);
    } catch (_) {}
  }

  // ── URL Synchronization with Iframe ────────────
  let isInitialFrameSync = true;
  let isPopstateNavigating = false;

  function syncUrlFromIframe(isReplace = false) {
    if (isPopstateNavigating) return;
    if (!siteFrame || !siteFrame.contentWindow) return;

    try {
      const frameWin = siteFrame.contentWindow;
      const frameLoc = frameWin.location;
      if (!frameLoc || !frameLoc.pathname || frameLoc.pathname === 'blank' || frameLoc.pathname === 'about:blank') {
        return;
      }

      const framePath = frameLoc.pathname;
      if (framePath === '/room' || framePath === '/room.html') return;

      const frameParams = new URLSearchParams(frameLoc.search);
      frameParams.delete('embedded');
      frameParams.delete('view');
      if (!frameParams.has('code') && ROOM_CODE) {
        frameParams.set('code', ROOM_CODE);
      }

      const searchStr = frameParams.toString() ? `?${frameParams.toString()}` : '';
      const cleanUrl = `${framePath}${searchStr}`;
      const currentTop = `${window.location.pathname}${window.location.search}`;

      if (cleanUrl !== currentTop) {
        if (isInitialFrameSync || isReplace) {
          window.history.replaceState({ snugglePath: cleanUrl }, '', cleanUrl);
        } else {
          window.history.pushState({ snugglePath: cleanUrl }, '', cleanUrl);
        }
      }
      isInitialFrameSync = false;
    } catch (err) {
      console.warn('[Snuggle Shell] Sync URL error:', err);
    }
  }

  function observeFrameHistory() {
    try {
      const frameWin = siteFrame && siteFrame.contentWindow;
      if (!frameWin || frameWin.__snuggleHistoryObserved) return;
      frameWin.__snuggleHistoryObserved = true;

      const origPush = frameWin.history.pushState;
      if (typeof origPush === 'function') {
        frameWin.history.pushState = function (...args) {
          const ret = origPush.apply(this, args);
          syncUrlFromIframe(false);
          attachScrollListenersToFrame();
          return ret;
        };
      }

      const origReplace = frameWin.history.replaceState;
      if (typeof origReplace === 'function') {
        frameWin.history.replaceState = function (...args) {
          const ret = origReplace.apply(this, args);
          syncUrlFromIframe(true);
          attachScrollListenersToFrame();
          return ret;
        };
      }
    } catch (_) {}
  }

  // ── Game Fullscreen Coordination ───────────────
  // Keep video call Picture-in-Picture visible when a game enters fullscreen.
  // When an element inside the activity frame requests fullscreen, we request
  // fullscreen on the top-level document (room-shell) and apply pseudo-fullscreen
  // to the game container inside the iframe. This ensures the PiP window is part
  // of the fullscreen top-layer rendering context and stays floating over the game.
  function hookFrameFullscreen() {
    try {
      const frameWin = siteFrame && siteFrame.contentWindow;
      const frameDoc = siteFrame && (siteFrame.contentDocument || frameWin?.document);
      if (!frameWin || !frameDoc || frameWin.__snuggleFsHooked) return;
      frameWin.__snuggleFsHooked = true;

      const origElRequestFs = frameWin.Element.prototype.requestFullscreen;
      const origElWebkitRequestFs = frameWin.Element.prototype.webkitRequestFullscreen;
      const origDocExitFs = frameDoc.exitFullscreen || frameWin.Document.prototype.exitFullscreen;

      frameWin.Element.prototype.requestFullscreen = async function (options) {
        try {
          if (document.documentElement.requestFullscreen) {
            await document.documentElement.requestFullscreen(options);
          } else if (document.documentElement.webkitRequestFullscreen) {
            await document.documentElement.webkitRequestFullscreen(options);
          }
          this.classList.add('pseudo-fullscreen');
          this.dispatchEvent(new Event('fullscreenchange', { bubbles: true }));
          frameDoc.dispatchEvent(new Event('fullscreenchange'));
          hideRibbon();
          return Promise.resolve();
        } catch (_) {
          this.classList.add('pseudo-fullscreen');
          this.dispatchEvent(new Event('fullscreenchange', { bubbles: true }));
          frameDoc.dispatchEvent(new Event('fullscreenchange'));
          return Promise.resolve();
        }
      };

      if (origElWebkitRequestFs) {
        frameWin.Element.prototype.webkitRequestFullscreen = frameWin.Element.prototype.requestFullscreen;
      }

      frameDoc.exitFullscreen = async function () {
        try {
          if (document.fullscreenElement || document.webkitFullscreenElement) {
            if (document.exitFullscreen) await document.exitFullscreen();
            else if (document.webkitExitFullscreen) await document.webkitExitFullscreen();
          }
        } catch (_) {}
        const pseudoEls = frameDoc.querySelectorAll('.pseudo-fullscreen, .gp--pseudo');
        pseudoEls.forEach(el => {
          el.classList.remove('pseudo-fullscreen');
          el.classList.remove('gp--pseudo');
        });
        frameDoc.dispatchEvent(new Event('fullscreenchange'));
        return Promise.resolve();
      };

      if (frameWin.Document && frameWin.Document.prototype) {
        frameWin.Document.prototype.exitFullscreen = frameDoc.exitFullscreen;
      }

      try {
        Object.defineProperty(frameDoc, 'fullscreenElement', {
          get: () => {
            const pseudo = frameDoc.querySelector('.pseudo-fullscreen, .gp--pseudo');
            if (pseudo) return pseudo;
            return (document.fullscreenElement || document.webkitFullscreenElement) ? frameDoc.body : null;
          },
          configurable: true
        });
      } catch (_) {}
    } catch (err) {
      console.warn('[Snuggle Shell] Could not hook frame fullscreen:', err);
    }
  }

  function onFrameLoaded() {
    syncUrlFromIframe(false);
    attachKeyHandlerToFrame();
    attachScrollListenersToFrame();
    observeFrameHistory();
    broadcastUserCountToFrame();
    hookFrameFullscreen();
  }

  function onPopState(e) {
    if (!siteFrame || !siteFrame.contentWindow) return;
    try {
      isPopstateNavigating = true;
      const targetPath = window.location.pathname;
      const targetParams = new URLSearchParams(window.location.search);
      if (!targetParams.has('code') && ROOM_CODE) {
        targetParams.set('code', ROOM_CODE);
      }
      targetParams.set('embedded', '1');
      const targetFrameUrl = `${targetPath}?${targetParams.toString()}`;

      siteFrame.contentWindow.location.replace(targetFrameUrl);
    } catch (err) {
      console.warn('[Snuggle Shell] Popstate navigation error:', err);
    } finally {
      setTimeout(() => { isPopstateNavigating = false; }, 300);
    }
  }

  // ── Bootstrap Room Shell ───────────────────────
  function init() {
    document.body.classList.add('loaded');

    const urlParams = new URLSearchParams(window.location.search);
    const urlCode = (urlParams.get('code') || '').toUpperCase().trim();
    const requestedTab = urlParams.get('tab');
    const requestedView = urlParams.get('view');

    if (urlCode) {
      ROOM_CODE = urlCode;
      try {
        sessionStorage.setItem('snuggle_room_code', ROOM_CODE);
        localStorage.setItem('snuggle_room_code', ROOM_CODE);
      } catch (_) {}
    } else {
      try {
        ROOM_CODE = sessionStorage.getItem('snuggle_room_code') || 
                    localStorage.getItem('snuggle_room_code');
      } catch (_) {}
    }

    if (!ROOM_CODE) {
      window.location.href = '/';
      return;
    }

    if (callRoomCode) callRoomCode.textContent = ROOM_CODE;

    // Resolve target section for iframe
    let targetSectionUrl = '';
    if (requestedView && requestedView.startsWith('/') && !requestedView.startsWith('/room')) {
      targetSectionUrl = requestedView;
    } else {
      const currentPath = window.location.pathname;
      if (currentPath && currentPath !== '/' && !currentPath.startsWith('/room')) {
        targetSectionUrl = `${currentPath}${window.location.search || ''}`;
      } else {
        targetSectionUrl = `/home?code=${encodeURIComponent(ROOM_CODE)}`;
      }
    }

    // Ensure room code and embedded=1 flag are in the iframe target
    const sep = targetSectionUrl.includes('?') ? '&' : '?';
    if (!targetSectionUrl.includes('code=')) {
      targetSectionUrl += `${sep}code=${encodeURIComponent(ROOM_CODE)}`;
    }
    const sep2 = targetSectionUrl.includes('?') ? '&' : '?';
    if (!targetSectionUrl.includes('embedded=')) {
      targetSectionUrl += `${sep2}embedded=1`;
    }

    // Clean user-visible URL in top window address bar
    let cleanTopPath = window.location.pathname;
    if (cleanTopPath === '/room' || cleanTopPath === '/room.html' || cleanTopPath === '/') {
      if (requestedView && requestedView.startsWith('/') && !requestedView.startsWith('/room')) {
        cleanTopPath = requestedView.split('?')[0];
      } else {
        cleanTopPath = '/home';
      }
    }
    const cleanParams = new URLSearchParams(window.location.search);
    cleanParams.delete('embedded');
    cleanParams.delete('view');
    cleanParams.set('code', ROOM_CODE);
    const cleanInitialUrl = `${cleanTopPath}?${cleanParams.toString()}`;

    try {
      window.history.replaceState({ snugglePath: cleanInitialUrl }, '', cleanInitialUrl);
    } catch (_) {}

    // Load Website Content inside Frame
    if (siteFrame) siteFrame.src = targetSectionUrl;

    setupListeners();

    // Connect WebSocket signaling for room
    connectWS();

    // Select initial tab
    if (requestedTab === 'call') {
      switchTab('call');
    } else {
      switchTab('site');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
