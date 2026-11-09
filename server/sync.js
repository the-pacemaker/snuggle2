const { WebSocketServer } = require('ws');
const os = require('os');
const { getIceServers } = require('./ice-servers');

function getLocalLanIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}
const LOCAL_LAN_IP = getLocalLanIp();

// --- Room Storage ---
const rooms = new Map();

// Room cleanup interval (5 minutes)
const CLEANUP_INTERVAL = 5 * 60 * 1000;
const ROOM_TTL = 60 * 60 * 1000; // Rooms expire after 1 hour of no activity

// --- Room Code Generator ---
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No I, O, 0, 1 to avoid confusion
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  if (rooms.has(code)) return generateRoomCode();
  return code;
}

// --- Helpers ---
function getRoom(ws) {
  if (!ws.roomCode) {
    sendTo(ws, { type: 'error', message: 'Not in a room' });
    return null;
  }
  const room = rooms.get(ws.roomCode);
  if (!room) {
    ws.roomCode = null;
    sendTo(ws, { type: 'error', message: 'Room no longer exists' });
    return null;
  }
  return room;
}

function sendTo(ws, data) {
  if (ws.readyState === 1) { // WebSocket.OPEN
    ws.send(JSON.stringify(data));
  }
}

function getUniqueUsersCount(room) {
  if (!room) return 0;
  const uniqueSessions = new Set();
  let anonymousCount = 0;
  room.users.forEach(u => {
    if (u.sessionId) uniqueSessions.add(u.sessionId);
    else anonymousCount++;
  });
  if (room.pendingLeaves) {
    room.pendingLeaves.forEach((_, sid) => {
      uniqueSessions.add(sid);
    });
  }
  return Math.max(1, uniqueSessions.size + anonymousCount);
}

function broadcastToRoom(code, data, excludeWs = null) {
  const room = rooms.get(code);
  if (!room) return;

  const msg = JSON.stringify(data);
  const isWebRtc = data && data.type && (data.type.startsWith('webrtc_') || data.type === 'room_invite');
  const senderId = (data && (data.from || data.senderId)) || (excludeWs && excludeWs.sessionId);

  room.users.forEach(user => {
    if (user !== excludeWs && user.readyState === 1) {
      if (!isWebRtc && senderId && user.sessionId && user.sessionId === senderId) {
        return;
      }
      user.send(msg);
    }
  });
}

function relayToRoom(ws, msg) {
  const room = getRoom(ws);
  if (!room) return;
  room.lastActivity = Date.now();
  broadcastToRoom(room.code, msg, ws);
}

function extractSessionId(msg) {
  if (!msg) return null;
  if (msg.sessionId && typeof msg.sessionId === 'string') {
    return msg.sessionId;
  }
  const raw = msg.from || msg.senderId;
  if (typeof raw !== 'string') return null;
  // If raw is formatted as "usr_<session>_<peer>", extract "usr_<session>"
  const m = raw.match(/^(usr_[a-zA-Z0-9]+)_[a-zA-Z0-9]+$/);
  if (m) return m[1];
  return raw;
}

// --- Game Snapshot Persistence ---
// Detects whether a game_sync message carries authoritative full state worth persisting.
// connections: action.kind === 'state'
// wordle:      Array.isArray(msg.history) at the top level
function extractGameSnapshot(msg) {
  // Connections: { type:'game_sync', from, action:{ kind:'state', pid, puzzle, clock, sel, order, guesses } }
  if (msg.type === 'game_sync' && msg.action && msg.action.kind === 'state') {
    return { game: 'connections', snapshot: msg };
  }
  // Wordle: { type:'game_sync', history:[...], from }
  if (msg.type === 'game_sync' && Array.isArray(msg.history) && msg.history.length > 0) {
    return { game: 'wordle', snapshot: msg };
  }
  // Strands: { type:'game_sync', action:'full_state', state:{...} }
  if (msg.type === 'game_sync' && msg.action === 'full_state' && msg.state) {
    return { game: 'strands', snapshot: msg };
  }
  return null;
}

// --- Room Actions ---
function createRoom(ws, requestedCode) {
  if (ws.roomCode) leaveRoom(ws);

  let code;
  if (requestedCode && !rooms.has(requestedCode.toUpperCase().trim())) {
    code = requestedCode.toUpperCase().trim();
  } else {
    code = generateRoomCode();
  }
  const room = {
    code,
    users: new Set([ws]),
    pendingLeaves: new Map(),
    ytPlaylists: [],
    ytQueue: [],
    lastActivity: Date.now(),
    // game snapshots: { connections: <msg>, wordle: <msg> }
    gameSnapshots: {}
  };

  rooms.set(code, room);
  ws.roomCode = code;

  sendTo(ws, {
    type: 'room_created',
    code,
    iceServers: getIceServers()
  });

  console.log(`Room ${code} created. Total rooms: ${rooms.size}`);
}

function joinRoom(ws, code) {
  if (!code) {
    sendTo(ws, { type: 'error', message: 'Room code is required' });
    return;
  }

  code = code.toUpperCase().trim();

  if (ws.roomCode && ws.roomCode !== code) leaveRoom(ws);

  const room = rooms.get(code);
  if (!room) {
    // Room doesn't exist, create it with the requested code
    createRoom(ws, code);
    return;
  }

  if (!room.pendingLeaves) {
    room.pendingLeaves = new Map();
  }

  const userSessionId = ws.sessionId;

  // Check if this user is already represented in this room:
  // 1. By another currently active WebSocket socket
  const isAlreadyConnected = Boolean(
    userSessionId && Array.from(room.users).some(u => u !== ws && u.sessionId === userSessionId)
  );

  // 2. By a pending leave timer during a grace period (e.g. reload or page navigation)
  let hadPendingLeave = false;
  if (userSessionId && room.pendingLeaves.has(userSessionId)) {
    clearTimeout(room.pendingLeaves.get(userSessionId));
    room.pendingLeaves.delete(userSessionId);
    hadPendingLeave = true;
  }

  const isUserAlreadyInRoom = isAlreadyConnected || hadPendingLeave;

  room.users.add(ws);
  room.lastActivity = Date.now();
  ws.roomCode = code;

  sendTo(ws, {
    type: 'room_joined',
    code,
    usersCount: getUniqueUsersCount(room),
    iceServers: getIceServers()
  });

  // ── Replay persisted game snapshots so the client recovers full state ──
  // This works even when no other player is connected (e.g. after a refresh).
  if (room.gameSnapshots.connections) {
    sendTo(ws, room.gameSnapshots.connections);
  }
  if (room.gameSnapshots.wordle) {
    sendTo(ws, room.gameSnapshots.wordle);
  }
  if (room.gameSnapshots.strands) {
    sendTo(ws, room.gameSnapshots.strands);
  }

  // ── YouTube state ──
  if (room.ytSnapshot) {
    const snapshotToSend = {
      ...room.ytSnapshot,
      queue: room.ytQueue && room.ytQueue.length > 0 ? room.ytQueue : (room.ytSnapshot.queue || []),
      playlists: room.ytPlaylists
    };
    sendTo(ws, {
      type: 'yt_sync_snapshot',
      snapshot: snapshotToSend
    });
  } else if (room.ytQueue && room.ytQueue.length > 0) {
    sendTo(ws, {
      type: 'yt_sync_snapshot',
      snapshot: { queue: room.ytQueue, playlists: room.ytPlaylists }
    });
  } else if (room.ytPlaylists && room.ytPlaylists.length > 0) {
    sendTo(ws, {
      type: 'yt_sync_snapshot',
      snapshot: { playlists: room.ytPlaylists }
    });
  }

  // Broadcast user_joined ONLY when a user who was not already in the room joins!
  if (!isUserAlreadyInRoom) {
    broadcastToRoom(code, {
      type: 'user_joined',
      usersCount: getUniqueUsersCount(room),
      from: ws.sessionId
    }, ws);
    console.log(`User ${ws.sessionId || 'anon'} joined room ${code}. Total users: ${getUniqueUsersCount(room)}`);
  } else {
    console.log(`User ${ws.sessionId || 'anon'} added connection to room ${code} (already present). Suppressed user_joined.`);
  }
}

function leaveRoom(ws, immediate = false) {
  const code = ws.roomCode;
  if (!code) return;

  const room = rooms.get(code);
  if (!room) {
    ws.roomCode = null;
    return;
  }

  room.users.delete(ws);
  ws.roomCode = null;

  const userSessionId = ws.sessionId;

  // Check if this user still has another active socket in the room
  const hasOtherSocket = Boolean(
    userSessionId && Array.from(room.users).some(u => u.sessionId === userSessionId)
  );

  if (hasOtherSocket) {
    // User is still present in the room via another socket (e.g. room shell or another tab).
    // Do not notify friend that user left!
    console.log(`Socket closed for user ${userSessionId || 'anon'}, but user still has active sockets in room ${code}. Suppressed user_left.`);
    return;
  }

  // User has no remaining active sockets in this room.
  if (userSessionId && !immediate) {
    // Start a 3500ms grace period so route changes, reloads, or temporary network drops
    // do not trigger false "friend left" / "friend joined" notifications.
    if (!room.pendingLeaves) room.pendingLeaves = new Map();

    if (room.pendingLeaves.has(userSessionId)) {
      clearTimeout(room.pendingLeaves.get(userSessionId));
    }

    const timer = setTimeout(() => {
      if (rooms.has(code)) {
        room.pendingLeaves.delete(userSessionId);
        const reconnected = Array.from(room.users).some(u => u.sessionId === userSessionId);
        if (!reconnected) {
          console.log(`User ${userSessionId} truly left room ${code} (grace period expired). Broadcasting user_left.`);
          broadcastToRoom(code, {
            type: 'user_left',
            usersCount: getUniqueUsersCount(room),
            from: userSessionId
          });
        }
      }
    }, 3500);

    room.pendingLeaves.set(userSessionId, timer);
  } else {
    // Either immediate leave or anonymous user without session ID
    if (userSessionId && room.pendingLeaves && room.pendingLeaves.has(userSessionId)) {
      clearTimeout(room.pendingLeaves.get(userSessionId));
      room.pendingLeaves.delete(userSessionId);
    }
    broadcastToRoom(code, {
      type: 'user_left',
      usersCount: getUniqueUsersCount(room),
      from: userSessionId
    });
  }

  if (room.users.size === 0) {
    // Keep the room alive — it will be cleaned up after TTL expires.
    // This preserves game state for refreshing players.
    console.log(`Room ${code} now empty, kept alive for ${ROOM_TTL / 60000} min. Total rooms: ${rooms.size}`);
  }
}

function updateSnapshot(ws, snapshot) {
  const room = getRoom(ws);
  if (!room || !snapshot) return;
  room.lastActivity = Date.now();
  room.ytSnapshot = snapshot;
  room.ytSnapshot.timestamp = Date.now();

  // Keep the room-level queue in sync with the latest snapshot queue
  if (snapshot.queue && snapshot.queue.length > 0) {
    room.ytQueue = snapshot.queue;
  }
}

function handleMessage(ws, msg) {
  const sid = extractSessionId(msg);
  if (sid) {
    ws.sessionId = sid;
  }
  switch (msg.type) {
    case 'create_room': createRoom(ws); break;
    case 'join_room': joinRoom(ws, msg.code); break;
    case 'leave_room':
      if (ws.sessionId && ws.roomCode && rooms.has(ws.roomCode)) {
        const r = rooms.get(ws.roomCode);
        if (r && r.pendingLeaves && r.pendingLeaves.has(ws.sessionId)) {
          clearTimeout(r.pendingLeaves.get(ws.sessionId));
          r.pendingLeaves.delete(ws.sessionId);
        }
      }
      leaveRoom(ws, true);
      break;
    case 'ping': sendTo(ws, { type: 'pong' }); break;
    case 'yt_play':
    case 'yt_pause':
    case 'yt_seek':
    case 'yt_load_video':
    case 'yt_subtitle_offset':
    case 'yt_subtitle_file':
    case 'yt_tick':
    case 'yt_queue_reorder':
    case 'yt_next':
    case 'yt_prev':
    case 'webrtc_signal':
    case 'webrtc_offer':
    case 'webrtc_answer':
    case 'webrtc_candidate':      // sent by call.js
    case 'webrtc_ice_candidate':  // kept for backwards compatibility
    case 'webrtc_status':
    case 'room_invite':
      if (ws.clientIp && !msg.senderIp) {
        msg.senderIp = ws.clientIp;
      }
      if (['webrtc_candidate', 'webrtc_ice_candidate', 'webrtc_offer', 'webrtc_answer', 'webrtc_status'].includes(msg.type)) {
        const candStr = msg.candidate ? (msg.candidate.candidate || JSON.stringify(msg.candidate)) : undefined;
        console.log(`[SYNC-WEBRTC] type=${msg.type} room=${ws.roomCode} from=${msg.from || ws.sessionId} ip=${msg.senderIp || ws.clientIp}${candStr ? ` cand="${candStr}"` : ''}${msg.status ? ` status=${msg.status}` : ''}${msg.callActive !== undefined ? ` callActive=${msg.callActive}` : ''}`);
      }
      relayToRoom(ws, msg);
      break;
    case 'game_sync': {
      // Persist state snapshots so rejoining clients can recover without a peer online
      const extracted = extractGameSnapshot(msg);
      if (extracted && ws.roomCode && rooms.has(ws.roomCode)) {
        const room = rooms.get(ws.roomCode);
        room.gameSnapshots[extracted.game] = extracted.snapshot;
        room.lastActivity = Date.now();
      }
      relayToRoom(ws, msg);
      break;
    }
    case 'yt_queue_add':
      if (ws.roomCode && rooms.has(ws.roomCode)) {
        const room = rooms.get(ws.roomCode);
        if (msg.video) {
          if (!room.ytQueue) room.ytQueue = [];
          room.ytQueue.push(msg.video);
        }
        relayToRoom(ws, msg);
      }
      break;
    case 'yt_queue_remove':
      if (ws.roomCode && rooms.has(ws.roomCode)) {
        const room = rooms.get(ws.roomCode);
        if (room.ytQueue && typeof msg.index === 'number' && msg.index >= 0 && msg.index < room.ytQueue.length) {
          room.ytQueue.splice(msg.index, 1);
        }
        relayToRoom(ws, msg);
      }
      break;
    case 'yt_playlist_add':
      if (ws.roomCode && rooms.has(ws.roomCode)) {
        rooms.get(ws.roomCode).ytPlaylists.push(msg.playlist);
        relayToRoom(ws, msg);
      }
      break;
    case 'yt_update_snapshot':
      updateSnapshot(ws, msg.snapshot);
      break;
    default:
      console.warn('Unknown message type:', msg.type);
  }
}

function handleDisconnect(ws) {
  if (ws.roomCode) leaveRoom(ws);
}

let wss;
let heartbeatInterval;
let cleanupInterval;

function setupWebSocket(httpServer, httpsServer = null) {
  wss = new WebSocketServer({ noServer: true });

  const onUpgrade = (request, socket, head) => {
    let pathname = '/';
    try {
      pathname = new URL(request.url, 'http://localhost').pathname;
    } catch (_) {}
    if (pathname === '/coop-signal' || pathname === '/bcoop-signal' || pathname === '/ccoop-signal' || pathname === '/contra-signal' || pathname === '/ws') return;

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  };

  if (httpServer) {
    httpServer.on('upgrade', onUpgrade);
  }
  if (httpsServer) {
    httpsServer.on('upgrade', onUpgrade);
  }

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    let clientIp = req?.socket?.remoteAddress || '';
    if (clientIp.startsWith('::ffff:')) {
      clientIp = clientIp.substring(7);
    }
    // If client connects from loopback on server machine (laptop), stamp with LAN IP
    if (!clientIp || clientIp === '127.0.0.1' || clientIp === '::1') {
      clientIp = LOCAL_LAN_IP;
    }
    ws.clientIp = clientIp;

    ws.roomCode = null;

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        sendTo(ws, { type: 'error', message: 'Invalid message format' });
        return;
      }
      handleMessage(ws, msg);
    });

    ws.on('close', () => handleDisconnect(ws));
    ws.on('error', (err) => console.error('WebSocket error:', err.message));
  });

  heartbeatInterval = setInterval(() => {
    wss.clients.forEach(ws => {
      if (!ws.isAlive) {
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      // Delete rooms that have been inactive past TTL
      // Empty rooms stay alive until TTL so refreshing players can rejoin
      if (now - room.lastActivity > ROOM_TTL) {
        if (room.pendingLeaves) {
          room.pendingLeaves.forEach(t => clearTimeout(t));
          room.pendingLeaves.clear();
        }
        room.users.forEach(ws => {
          sendTo(ws, { type: 'error', message: 'Room expired' });
          ws.roomCode = null;
        });
        rooms.delete(code);
        console.log(`Room ${code} cleaned up (expired after ${ROOM_TTL / 60000} min). Total rooms: ${rooms.size}`);
      }
    }
  }, CLEANUP_INTERVAL);

  return { wss, rooms };
}

function teardownWebSocket() {
  clearInterval(heartbeatInterval);
  clearInterval(cleanupInterval);
  if (wss) {
    wss.clients.forEach(ws => {
      sendTo(ws, { type: 'error', message: 'Server shutting down' });
      ws.close();
    });
    wss.close();
  }
}

module.exports = {
  setupWebSocket,
  teardownWebSocket
};
