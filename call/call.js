/* =============================================
   SNUGGLE — WebRTC Video Call Client (call.js)
   ============================================= */

(function () {
  'use strict';

  // Ensure body is immediately visible (prevent opacity 0 blank page)
  if (document.body) {
    document.body.classList.add('loaded');
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      document.body.classList.add('loaded');
    });
  }

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
  let ws = null;
  let pc = null;
  let localStream = null;
  let remoteStream = null;
  let iceQueue = [];
  let isPolite = false;
  let makingOffer = false;
  let remoteClientId = null;
  let currentFacingMode = 'user'; // 'user' or 'environment'
  let isMicMuted = false;
  let isCamOff = false;
  let hasMultipleCameras = false;
  let pingInterval = null;
  let isStarted = false;
  let usersCount = 1;

  // ── DOM References ─────────────────────────────
  const $ = (id) => document.getElementById(id);
  const localVideo = $('local-video');
  const remoteVideo = $('remote-video');
  const localContainer = $('local-container');
  const remoteContainer = $('remote-container');
  const localPlaceholder = $('local-placeholder');
  const remotePlaceholder = $('remote-placeholder');
  const remotePlaceholderText = $('remote-placeholder-text');
  const remoteMutedBadge = $('remote-muted-badge');
  const callStatusDot = $('call-status-dot');
  const callStatusText = $('call-status-text');
  const callTimerText = $('call-timer-text');
  const remoteSpeakingIndicator = $('remote-speaking-indicator');
  const localSpeakingIndicator = $('local-speaking-indicator');
  const callRoomCode = $('call-room-code');
  const callRoomPill = $('call-room-pill');
  const callStage = $('call-stage');
  const callToast = $('call-toast');
  const permDialog = $('permission-dialog');
  const permDialogDesc = $('perm-dialog-desc');
  const btnSwitchHttps = $('btn-switch-https');

  // Control Buttons
  const ctrlMic = $('ctrl-mic');
  const iconMicOn = $('icon-mic-on');
  const iconMicOff = $('icon-mic-off');
  const ctrlCam = $('ctrl-cam');
  const iconCamOn = $('icon-cam-on');
  const iconCamOff = $('icon-cam-off');
  const ctrlSwitchCam = $('ctrl-switch-cam');
  const ctrlPip = $('ctrl-pip');
  const ctrlSwap = $('ctrl-swap');
  const ctrlLeave = $('ctrl-leave');
  const btnInvite = $('btn-invite-friend');
  const btnRetryPerm = $('btn-retry-perm');

  // ── Toast Utility ──────────────────────────────
  let toastTimer = null;
  function showToast(message, duration = 3000) {
    if (!callToast) return;
    callToast.textContent = message;
    callToast.classList.add('is-active');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      callToast.classList.remove('is-active');
    }, duration);
  }

  // ── UI Status Helpers ──────────────────────────
  function setStatus(state, label) {
    if (callStatusDot) {
      callStatusDot.className = 'call-status__dot';
      switch (state) {
        case 'connected':
          callStatusDot.classList.add('is-connected');
          break;
        case 'waiting':
          callStatusDot.classList.add('is-waiting');
          break;
        case 'disconnected':
          callStatusDot.classList.add('is-disconnected');
          break;
        default:
          break;
      }
    }

    const statusEls = document.querySelectorAll('.call-status-text');
    statusEls.forEach(el => { el.textContent = label; });
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
    if (callTimerText) {
      callTimerText.textContent = '00:00';
      callTimerText.hidden = true;
    }
  }

  function updateCallTimerDisplay() {
    if (!callStartTime || !callTimerText) return;
    const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
    const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const s = String(elapsed % 60).padStart(2, '0');
    callTimerText.textContent = `${m}:${s}`;
    callTimerText.hidden = false;
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

      if (localStream && localStream.getAudioTracks().length > 0 && !localAudioAnalyser) {
        try {
          const localSrc = audioCtx.createMediaStreamSource(localStream);
          localAudioAnalyser = audioCtx.createAnalyser();
          localAudioAnalyser.fftSize = 64;
          localAudioAnalyser.smoothingTimeConstant = 0.4;
          localSrc.connect(localAudioAnalyser);
        } catch (err) {
          console.warn('[Snuggle Call] Local audio analyser err:', err);
        }
      }

      if (remoteStream && remoteStream.getAudioTracks().length > 0 && !remoteAudioAnalyser) {
        try {
          const remoteSrc = audioCtx.createMediaStreamSource(remoteStream);
          remoteAudioAnalyser = audioCtx.createAnalyser();
          remoteAudioAnalyser.fftSize = 64;
          remoteAudioAnalyser.smoothingTimeConstant = 0.4;
          remoteSrc.connect(remoteAudioAnalyser);
        } catch (err) {
          console.warn('[Snuggle Call] Remote audio analyser err:', err);
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
        }, 120);
      }
    } catch (e) {
      console.warn('[Snuggle Call] AudioContext setup err:', e);
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
  }

  // ── Secure Context & HTTPS Mobile Support ──────
  function checkSecureContext() {
    const isLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname);
    if (!window.isSecureContext && !isLocal) {
      if (btnSwitchHttps && permDialogDesc) {
        permDialogDesc.textContent = 'Mobile browsers require a secure HTTPS connection for camera and microphone access. Tap below to switch to the secure HTTPS connection on your local network:';
        btnSwitchHttps.href = `https://${window.location.hostname}:3443/call${window.location.search}`;
        btnSwitchHttps.style.display = 'block';
      }
      if (permDialog) permDialog.hidden = false;
      return false;
    }
    return true;
  }

  // ── Initialize Media ───────────────────────────
  async function initMedia(facingMode = 'user') {
    // Check if browser supports mediaDevices
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      console.warn('[Snuggle VideoCall] navigator.mediaDevices not supported in this context');
      checkSecureContext();
      if (permDialog) permDialog.hidden = false;
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
      localVideo.srcObject = localStream;
      localPlaceholder.hidden = true;
      if (permDialog) permDialog.hidden = true;

      // Check if device has multiple cameras (e.g. mobile front/back)
      checkCameraCount();

      // If peer connection already exists, attach tracks
      if (pc && localStream) {
        localStream.getTracks().forEach(track => {
          const senders = pc.getSenders();
          const alreadyAdded = senders.some(s => s.track && s.track.id === track.id);
          if (!alreadyAdded) {
            pc.addTrack(track, localStream);
          }
        });
      }

      return localStream;
    } catch (err) {
      console.warn('[Snuggle VideoCall] Camera/mic access failed, attempting audio-only fallback:', err);
      try {
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
          localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          localVideo.srcObject = null;
          localPlaceholder.hidden = false;
          isCamOff = true;
          updateCamButtonUI();
          if (permDialog) permDialog.hidden = true;
          showToast('Connected with microphone only (camera off)');
          return localStream;
        }
      } catch (audioErr) {
        console.error('[Snuggle VideoCall] Media permission completely denied:', audioErr);
        checkSecureContext();
        if (permDialog) permDialog.hidden = false;
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
    } catch (e) {
      // ignore
    }
  }

  // ── WebRTC PeerConnection Setup ────────────────
  function createPeerConnection() {
    if (pc) {
      try { pc.close(); } catch (e) {}
    }

    pc = new RTCPeerConnection(RTC_CONFIG);
    iceQueue = [];

    // Add local tracks to peer connection
    if (localStream) {
      localStream.getTracks().forEach(track => {
        pc.addTrack(track, localStream);
      });
    }

    // Remote track arrived
    pc.ontrack = (event) => {
      console.log('[Snuggle VideoCall] Remote track received:', event.track.kind);
      if (!remoteStream) {
        remoteStream = new MediaStream();
        remoteVideo.srcObject = remoteStream;
      }
      remoteStream.addTrack(event.track);

      setStatus('connected', 'Connected (P2P)');
      remotePlaceholder.hidden = true;
      startCallTimer();
      setupAudioAnalysis();

      if (event.track.kind === 'video') {
        remoteVideo.play().catch(e => console.warn('Remote video play err:', e));
      }
    };

    // Connection State changes
    pc.onconnectionstatechange = () => {
      console.log('[Snuggle VideoCall] Connection State:', pc.connectionState);
      if (pc.connectionState === 'connected') {
        setStatus('connected', 'Connected (P2P)');
        remotePlaceholder.hidden = true;
        startCallTimer();
        setupAudioAnalysis();
        showToast('Call connected 🎉');
      } else if (pc.connectionState === 'disconnected') {
        setStatus('waiting', 'Reconnecting...');
      } else if (pc.connectionState === 'failed') {
        setStatus('disconnected', 'Connection failed');
      }
    };

    // ICE Candidate generation
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendWS({
          type: 'webrtc_candidate',
          candidate: event.candidate,
          from: clientId
        });
      }
    };

    // ICE Connection State changes
    pc.oniceconnectionstatechange = () => {
      console.log('[Snuggle VideoCall] ICE Connection State:', pc.iceConnectionState);
      switch (pc.iceConnectionState) {
        case 'connected':
        case 'completed':
          setStatus('connected', 'Connected (P2P)');
          remotePlaceholder.hidden = true;
          showToast('Call connected 🎉');
          break;
        case 'checking':
          setStatus('connecting', 'Connecting P2P...');
          break;
        case 'disconnected':
          setStatus('waiting', 'Reconnecting...');
          break;
        case 'failed':
          setStatus('disconnected', 'Connection failed');
          if (isPolite) {
            initiateCall();
          }
          break;
      }
    };

    // Negotiation Needed handler
    pc.onnegotiationneeded = async () => {
      try {
        makingOffer = true;
        await pc.setLocalDescription();
        sendWS({
          type: 'webrtc_offer',
          offer: pc.localDescription,
          from: clientId
        });
      } catch (err) {
        console.error('[Snuggle VideoCall] Negotiation error:', err);
      } finally {
        makingOffer = false;
      }
    };

    return pc;
  }

  // ── Signaling Initiator ────────────────────────
  async function initiateCall() {
    if (!pc) createPeerConnection();
    try {
      makingOffer = true;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendWS({
        type: 'webrtc_offer',
        offer: pc.localDescription,
        from: clientId
      });
      console.log('[Snuggle VideoCall] Offer sent');
    } catch (err) {
      console.error('[Snuggle VideoCall] Error creating offer:', err);
    } finally {
      makingOffer = false;
    }
  }

  // ── WebSocket Signaling ────────────────────────
  function connectWS() {
    setStatus('connecting', 'Connecting...');
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log('[Snuggle VideoCall] WebSocket connected to room', ROOM_CODE);
      sendWS({ type: 'join_room', code: ROOM_CODE, from: clientId });
      
      clearInterval(pingInterval);
      pingInterval = setInterval(() => {
        sendWS({ type: 'ping' });
      }, 25000);
    };

    ws.onmessage = async (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        return;
      }

      switch (msg.type) {
        case 'room_created':
        case 'room_joined':
          console.log('[Snuggle VideoCall] Joined room. Users count:', msg.usersCount);
          if (Array.isArray(msg.iceServers) && msg.iceServers.length > 0) {
            RTC_CONFIG.iceServers = msg.iceServers;
          }
          usersCount = msg.usersCount || 1;
          if (msg.code) {
            ROOM_CODE = msg.code;
            sessionStorage.setItem('snuggle_room_code', ROOM_CODE);
            localStorage.setItem('snuggle_room_code', ROOM_CODE);
            const callBackBtn = $('call-back-btn');
            if (callBackBtn) callBackBtn.href = `/home?code=${encodeURIComponent(ROOM_CODE)}`;
          }
          if (msg.usersCount >= 2) {
            setStatus('connecting', 'Friend is here, connecting...');
            remotePlaceholderText.textContent = 'Connecting with friend...';
            sendWS({
              type: 'webrtc_status',
              from: clientId,
              status: 'ready'
            });
          } else {
            setStatus('waiting', 'Waiting for friend');
            remotePlaceholderText.textContent = 'Waiting for friend to join...';
            remotePlaceholder.hidden = false;
          }
          break;

        case 'room_invite':
          if (window.SnuggleInvite) window.SnuggleInvite.showInviteModal(msg);
          break;

        case 'user_joined':
          if (msg.from && (msg.from === clientId || msg.from === sessionId)) return;
          usersCount = 2;
          console.log('[Snuggle VideoCall] Friend joined the room!');
          if (window.self === window.top) {
            showToast('Friend entered the room! Starting call...');
          }
          setStatus('connecting', 'Connecting with friend...');
          remotePlaceholderText.textContent = 'Connecting with friend...';
          createPeerConnection();
          initiateCall();
          break;

        case 'user_left':
          if (msg.from && (msg.from === clientId || msg.from === sessionId)) return;
          usersCount = 1;
          console.log('[Snuggle VideoCall] Friend left the room');
          if (window.self === window.top) {
            showToast('Your friend left the room');
          }
          setStatus('waiting', 'Waiting for friend');
          resetRemoteView();
          break;

        case 'webrtc_status':
          if (msg.from && msg.from !== clientId) {
            remoteClientId = msg.from;
            isPolite = clientId > remoteClientId;
            if (msg.status === 'ready' && !pc) {
              createPeerConnection();
              if (!isPolite) {
                initiateCall();
              }
            }
            if (typeof msg.audioMuted === 'boolean' && remoteMutedBadge) {
              remoteMutedBadge.hidden = !msg.audioMuted;
              remoteMutedBadge.closest('.video-badge--remote, .CallingAudioIndicator')?.classList.toggle('is-muted', msg.audioMuted);
            }
            if (typeof msg.videoOff === 'boolean') {
              if (msg.videoOff) {
                remotePlaceholder.hidden = false;
                remotePlaceholderText.textContent = 'Friend has turned off camera';
              } else {
                if (remoteStream && remoteStream.getVideoTracks().length > 0) {
                  remotePlaceholder.hidden = true;
                }
              }
            }
          }
          break;

        case 'webrtc_offer':
          if (msg.from === clientId) return;
          remoteClientId = msg.from;
          isPolite = clientId > remoteClientId;

          if (!pc) createPeerConnection();

          const offerCollision = makingOffer || pc.signalingState !== 'stable';
          if (offerCollision) {
            if (!isPolite) {
              console.log('[Snuggle VideoCall] Impolite peer ignoring colliding offer');
              return;
            }
            console.log('[Snuggle VideoCall] Polite peer yielding to colliding offer');
          }

          try {
            await pc.setRemoteDescription(new RTCSessionDescription(msg.offer));
            
            while (iceQueue.length > 0) {
              const cand = iceQueue.shift();
              try { await pc.addIceCandidate(cand); } catch (e) {}
            }

            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            sendWS({
              type: 'webrtc_answer',
              answer: pc.localDescription,
              from: clientId
            });
            console.log('[Snuggle VideoCall] Answer sent');
          } catch (err) {
            console.error('[Snuggle VideoCall] Error handling offer:', err);
          }
          break;

        case 'webrtc_answer':
          if (msg.from === clientId || !pc) return;
          try {
            await pc.setRemoteDescription(new RTCSessionDescription(msg.answer));
            console.log('[Snuggle VideoCall] Remote answer accepted');

            while (iceQueue.length > 0) {
              const cand = iceQueue.shift();
              try { await pc.addIceCandidate(cand); } catch (e) {}
            }
          } catch (err) {
            console.error('[Snuggle VideoCall] Error handling answer:', err);
          }
          break;

        case 'webrtc_candidate':
          if (msg.from === clientId) return;
          if (msg.candidate) {
            const candidate = new RTCIceCandidate(msg.candidate);
            if (pc && pc.remoteDescription && pc.remoteDescription.type) {
              try {
                await pc.addIceCandidate(candidate);
              } catch (err) {
                console.warn('[Snuggle VideoCall] Error adding candidate:', err);
              }
            } else {
              iceQueue.push(candidate);
            }
          }
          break;

        case 'error':
          console.warn('[Snuggle VideoCall] Server error:', msg.message);
          if (msg.message === 'Room no longer exists') {
            showToast('Room no longer exists, returning to home...');
            setTimeout(() => {
              window.location.href = '/';
            }, 1500);
          }
          break;
      }
    };

    ws.onclose = () => {
      console.warn('[Snuggle VideoCall] WebSocket closed, retrying in 3s...');
      clearInterval(pingInterval);
      setStatus('disconnected', 'Disconnected. Retrying...');
      setTimeout(connectWS, 3000);
    };

    ws.onerror = (err) => {
      console.error('[Snuggle VideoCall] WebSocket error:', err);
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
    remoteVideo.srcObject = null;
    remotePlaceholder.hidden = false;
    remotePlaceholderText.textContent = 'Waiting for friend to join...';
    if (remoteMutedBadge) {
      remoteMutedBadge.hidden = true;
      remoteMutedBadge.closest('.video-badge--remote, .CallingAudioIndicator')?.classList.remove('is-muted');
    }
    if (pc) {
      try { pc.close(); } catch (e) {}
      pc = null;
    }
  }

  // ── User Controls ──────────────────────────────
  // Mic Toggle
  function toggleMic() {
    isMicMuted = !isMicMuted;
    if (localStream) {
      const audioTrack = localStream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !isMicMuted;
      }
    }
    updateMicButtonUI();
    sendWS({
      type: 'webrtc_status',
      from: clientId,
      audioMuted: isMicMuted
    });
    showToast(isMicMuted ? 'Microphone muted' : 'Microphone unmuted');
  }

  function updateMicButtonUI() {
    ctrlMic.classList.toggle('ctrl-btn__icon--off', isMicMuted);
    if (isMicMuted) {
      iconMicOn.hidden = true;
      iconMicOff.hidden = false;
      ctrlMic.querySelector('.ctrl-btn__icon')?.classList.add('ctrl-btn__icon--off');
      ctrlMic.querySelector('.ctrl-btn__label') && (ctrlMic.querySelector('.ctrl-btn__label').textContent = 'Unmute');
    } else {
      iconMicOn.hidden = false;
      iconMicOff.hidden = true;
      ctrlMic.querySelector('.ctrl-btn__icon')?.classList.remove('ctrl-btn__icon--off');
      ctrlMic.querySelector('.ctrl-btn__label') && (ctrlMic.querySelector('.ctrl-btn__label').textContent = 'Mute');
    }
  }

  // Camera Toggle
  function toggleCamera() {
    isCamOff = !isCamOff;
    if (localStream) {
      const videoTrack = localStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !isCamOff;
      }
    }
    localPlaceholder.hidden = !isCamOff;
    updateCamButtonUI();
    sendWS({
      type: 'webrtc_status',
      from: clientId,
      videoOff: isCamOff
    });
    showToast(isCamOff ? 'Camera turned off' : 'Camera turned on');
  }

  function updateCamButtonUI() {
    ctrlCam.classList.toggle('ctrl-btn__icon--off', isCamOff);
    if (isCamOff) {
      iconCamOn.hidden = true;
      iconCamOff.hidden = false;
      ctrlCam.querySelector('.ctrl-btn__icon')?.classList.add('ctrl-btn__icon--off');
      ctrlCam.querySelector('.ctrl-btn__label') && (ctrlCam.querySelector('.ctrl-btn__label').textContent = 'Start Cam');
    } else {
      iconCamOn.hidden = false;
      iconCamOff.hidden = true;
      ctrlCam.querySelector('.ctrl-btn__icon')?.classList.remove('ctrl-btn__icon--off');
      ctrlCam.querySelector('.ctrl-btn__label') && (ctrlCam.querySelector('.ctrl-btn__label').textContent = 'Camera');
    }
  }

  // Switch Camera (Mobile front / back)
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
      const newVideoTrack = newStream.getVideoTracks()[0];
      if (!newVideoTrack) {
        showToast('No other camera found');
        return;
      }
      currentFacingMode = targetFacing;

      const oldVideoTrack = localStream.getVideoTracks()[0];
      if (oldVideoTrack) {
        oldVideoTrack.stop();
        localStream.removeTrack(oldVideoTrack);
      }
      localStream.addTrack(newVideoTrack);

      if (currentFacingMode === 'environment') {
        localVideo.style.transform = 'none';
      } else {
        localVideo.style.transform = '';
      }
      localVideo.srcObject = localStream;

      if (pc) {
        const senders = pc.getSenders();
        const videoSender = senders.find(s => s.track && s.track.kind === 'video');
        if (videoSender) {
          await videoSender.replaceTrack(newVideoTrack);
        }
      }
      if (ctrlSwitchCam) {
        ctrlSwitchCam.classList.toggle('is-flipped', currentFacingMode === 'environment');
      }
      showToast(currentFacingMode === 'user' ? 'Front camera' : 'Back camera');
    } catch (err) {
      console.warn('[Snuggle VideoCall] Switch camera error:', err);
      showToast('Could not switch camera');
    }
  }

  // Picture in Picture
  async function togglePiP() {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (remoteVideo && remoteVideo.srcObject) {
        await remoteVideo.requestPictureInPicture();
      } else if (localVideo && localVideo.srcObject) {
        await localVideo.requestPictureInPicture();
      } else {
        showToast('No active video for Picture-in-Picture');
      }
    } catch (err) {
      console.warn('PiP error:', err);
      showToast('Picture-in-Picture not supported or active');
    }
  }

  // Swap Views
  function toggleSwap() {
    callStage.classList.toggle('is-swapped');
  }

  // Share / Copy Room link
  async function shareRoom() {
    if (usersCount > 1) {
      if (window.SnuggleInvite && window.SnuggleInvite.markInviteSent) window.SnuggleInvite.markInviteSent();
      sendWS({
        type: 'room_invite',
        activity: 'Video Call',
        url: window.location.href,
        from: clientId,
        senderId: clientId
      });
      showToast('Invite sent to friend!');
      return;
    }

    const url = `${window.location.origin}/call?code=${ROOM_CODE}`;
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Join my Snuggle Video Call',
          text: `Join my Snuggle room ${ROOM_CODE} for a video call:`,
          url: url
        });
        return;
      } catch (e) {}
    }

    try {
      await navigator.clipboard.writeText(url);
    } catch (e) {
      const t = document.createElement('textarea');
      t.value = url;
      t.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(t);
      t.select();
      document.execCommand('copy');
      t.remove();
    }

    callRoomPill.classList.add('copied');
    showToast('Room link copied to clipboard!');
    setTimeout(() => {
      callRoomPill.classList.remove('copied');
    }, 2000);
  }

  // ── Setup Event Listeners ──────────────────────
  function setupListeners() {
    ctrlMic.addEventListener('click', toggleMic);
    ctrlCam.addEventListener('click', toggleCamera);
    if (ctrlSwitchCam) ctrlSwitchCam.addEventListener('click', switchCamera);
    ctrlPip.addEventListener('click', togglePiP);
    ctrlSwap.addEventListener('click', toggleSwap);
    localContainer.addEventListener('click', toggleSwap);

    ctrlLeave.addEventListener('click', () => {
      stopCallTimer();
      teardownAudioAnalysis();
      if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
      }
      if (pc) pc.close();
      if (ws) ws.close();
      window.location.href = `/home?code=${encodeURIComponent(ROOM_CODE)}`;
    });

    callRoomPill.addEventListener('click', shareRoom);
    btnInvite.addEventListener('click', shareRoom);

    btnRetryPerm.addEventListener('click', async () => {
      permDialog.hidden = true;
      await initMedia();
      if (localStream) {
        createPeerConnection();
        initiateCall();
      }
    });
  }

  // ── Start Call Session ─────────────────────────
  async function startCallSession() {
    if (isStarted) return;
    isStarted = true;

    const callBackBtn = $('call-back-btn');
    if (callBackBtn && ROOM_CODE) {
      callBackBtn.href = `/home?code=${encodeURIComponent(ROOM_CODE)}`;
    }

    if (callRoomCode) callRoomCode.textContent = 'Invite';

    // Start local media
    await initMedia();

    // Connect signaling WebSocket
    connectWS();

    // Track analytics event
    if (window.snuggleTrack) {
      window.snuggleTrack('call_page_open', { roomCode: ROOM_CODE });
    }
  }

  // ── Bootstrap ──────────────────────────────────
  function init() {
    document.body.classList.add('loaded');
    setupListeners();

    // Retrieve Room Code from URL or storage
    const urlParams = new URLSearchParams(window.location.search);
    const urlCode = urlParams.get('code');
    if (urlCode) {
      ROOM_CODE = urlCode.toUpperCase().trim();
      sessionStorage.setItem('snuggle_room_code', ROOM_CODE);
      localStorage.setItem('snuggle_room_code', ROOM_CODE);
    } else {
      ROOM_CODE = sessionStorage.getItem('snuggle_room_code') || 
                  localStorage.getItem('snuggle_room_code') || 
                  localStorage.getItem('snuggle_last_room_code');
    }

    if (!ROOM_CODE) {
      // Direct visit without room code — redirect to lobby like YouTube & Movies
      window.location.href = '/';
      return;
    }

    // Sync URL if needed
    if (!urlCode || urlCode.toUpperCase().trim() !== ROOM_CODE) {
      urlParams.set('code', ROOM_CODE);
      window.history.replaceState({}, '', `${window.location.pathname}?${urlParams.toString()}`);
    }

    const callBackBtn = $('call-back-btn');
    if (callBackBtn) {
      callBackBtn.href = `/home?code=${encodeURIComponent(ROOM_CODE)}`;
    }

    startCallSession();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
