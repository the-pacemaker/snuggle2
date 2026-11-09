'use strict';

const { RoomHub } = require('./hub');

/**
 * Attach the signaling endpoint to an existing Node `http.Server` (the one
 * your site already runs). Uses the standard `ws` package.
 *
 *   const { attachSignaling } = require('nes-coop-signaling');
 *   attachSignaling({
 *     server,                                   // your http(s).Server
 *     authorize: async (room, req) => {         // your lobby decides who may join
 *       const seat = await lobby.seatFor(req, room);   // e.g. from the session cookie
 *       return seat ? { role: seat === 1 ? 'host' : 'guest' } : false;
 *     },
 *     allowedOrigins: ['https://example.com'],
 *   });
 *
 * `authorize` may return false/null to refuse, true to accept with automatic
 * role assignment, or {role:'host'|'guest'} to pin the player slot.
 */
function attachSignaling(opts) {
  const {
    server,
    path = '/coop-signal',
    hub = new RoomHub(opts.hubOptions),
    authorize = async () => true,
    allowedOrigins = null,
    heartbeatMs = 20000,
    maxPayload = 64 * 1024,
    WebSocketServer = require('ws').WebSocketServer,
  } = opts;

  const wss = new WebSocketServer({ noServer: true, maxPayload });

  function refuse(socket, status, text) {
    try {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    } catch {
      /* socket already gone */
    }
    socket.destroy();
  }

  async function onUpgrade(req, socket, head) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return refuse(socket, 400, 'Bad Request');
    }
    if (url.pathname !== path) return; // not ours: leave it for other upgrade handlers

    if (allowedOrigins && !allowedOrigins.includes(req.headers.origin)) {
      return refuse(socket, 403, 'Forbidden');
    }
    const room = url.searchParams.get('room');
    if (!RoomHub.isValidRoomCode(room)) return refuse(socket, 400, 'Bad Request');

    let verdict;
    try {
      verdict = await authorize(room, req);
    } catch {
      return refuse(socket, 500, 'Internal Server Error');
    }
    if (!verdict) return refuse(socket, 403, 'Forbidden');
    const role = typeof verdict === 'object' ? verdict.role : undefined;

    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn = {
        send: (s) => ws.send(s),
        close: (code, reason) => ws.close(code, reason),
      };
      ws.isAlive = true;
      ws.on('pong', () => {
        ws.isAlive = true;
      });
      ws.on('message', (data, isBinary) => {
        if (isBinary) return ws.close(1003, 'text only');
        hub.message(conn, data.toString('utf8'));
      });
      const cleanup = () => hub.leave(conn);
      ws.on('close', cleanup);
      ws.on('error', cleanup);
      hub.join(room, conn, { role });
    });
  }

  const servers = Array.isArray(opts.servers) ? opts.servers : (opts.server ? [opts.server] : []);
  servers.forEach((srv) => {
    if (srv && typeof srv.on === 'function') {
      srv.on('upgrade', (req, socket, head) => {
        onUpgrade(req, socket, head).catch(() => socket.destroy());
      });
    }
  });

  // Drop peers that vanished without a TCP close (laptop lid, dead wifi).
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* closing */
      }
    }
  }, heartbeatMs);
  timer.unref?.();

  return {
    hub,
    wss,
    close() {
      clearInterval(timer);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}

module.exports = { attachSignaling };
