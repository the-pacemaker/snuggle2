const { WebSocketServer } = require('ws');

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
    // Strands
  if (msg.type === 'game_sync' && msg.action === 'full_state' && msg.state) {
    return { game: 'strands', snapshot: msg };
  }
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

function broadcastToRoom(code, data, excludeWs = null) {
  const room = rooms.get(code);
  if (!room) return;

  const msg = JSON.stringify(data);
  room.users.forEach(user => {
    if (user !== excludeWs && user.readyState === 1) {
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
    code
  });

  console.log(`Room ${code} created. Total rooms: ${rooms.size}`);
}

function joinRoom(ws, code) {
  if (!code) {
    sendTo(ws, { type: 'error', message: 'Room code is required' });
    return;
  }

  code = code.toUpperCase().trim();

  if (ws.roomCode) leaveRoom(ws);

  const room = rooms.get(code);
  if (!room) {
    // Room doesn't exist, create it with the requested code
    createRoom(ws, code);
    return;
  }

  room.users.add(ws);
  room.lastActivity = Date.now();
  ws.roomCode = code;

  sendTo(ws, {
    type: 'room_joined',
    code,
    usersCount: room.users.size
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

  broadcastToRoom(code, {
    type: 'user_joined',
    usersCount: room.users.size
  }, ws);

  console.log(`User joined room ${code}. Users: ${room.users.size}`);
}

function leaveRoom(ws) {
  const code = ws.roomCode;
  if (!code) return;

  const room = rooms.get(code);
  if (!room) {
    ws.roomCode = null;
    return;
  }

  room.users.delete(ws);
  ws.roomCode = null;

  if (room.users.size === 0) {
    // Keep the room alive — it will be cleaned up after TTL expires.
    // This preserves game state for refreshing players.
    console.log(`Room ${code} now empty, kept alive for ${ROOM_TTL / 60000} min. Total rooms: ${rooms.size}`);
  } else {
    broadcastToRoom(code, {
      type: 'user_left',
      usersCount: room.users.size
    });
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
  switch (msg.type) {
    case 'create_room': createRoom(ws); break;
    case 'join_room': joinRoom(ws, msg.code); break;
    case 'leave_room': leaveRoom(ws); break;
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

function setupWebSocket(server) {
  wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
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
    ws.on('pong', () => { ws.isAlive = true; });
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
