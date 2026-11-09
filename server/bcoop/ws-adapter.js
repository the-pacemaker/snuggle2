'use strict';

const { BattleCityHub } = require('./hub');

/**
 * Attach the Battle City signaling endpoint to existing Node http/https servers.
 * Supports /bcoop-signal and /ws paths.
 */
function attachBattleCitySignaling(opts = {}) {
  const {
    paths = ['/bcoop-signal', '/bcoop-signal-solo', '/ws'],
    hub = new BattleCityHub(opts.hubOptions),
    heartbeatMs = 30000,
    maxPayload = 64 * 1024,
    WebSocketServer = require('ws').WebSocketServer,
  } = opts;

  const pathList = Array.isArray(paths) ? paths : [paths];
  const wss = new WebSocketServer({ noServer: true, maxPayload });

  function refuse(socket, status, text) {
    try {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    } catch (_) {}
    socket.destroy();
  }

  async function onUpgrade(req, socket, head) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch (_) {
      return refuse(socket, 400, 'Bad Request');
    }

    if (!pathList.includes(url.pathname)) return; // Not our path

    const room = (url.searchParams.get('room') || url.searchParams.get('code') || '').toUpperCase().trim();
    if (!BattleCityHub.isValidRoomCode(room)) {
      return refuse(socket, 400, 'Invalid room code');
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const isSolo = url.pathname.endsWith('-solo') || url.searchParams.get('is_solo') === '1';
      const conn = {
        send: (s) => ws.send(s),
        close: (code, reason) => ws.close(code, reason),
        isSolo,
      };

      ws.isAlive = true;
      ws.on('pong', () => {
        ws.isAlive = true;
      });

      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          hub.message(conn, Buffer.from(data)); // will trigger binary check
          return;
        }
        hub.message(conn, data.toString('utf8'));
      });

      const cleanup = () => hub.leave(conn);
      ws.on('close', cleanup);
      ws.on('error', cleanup);

      hub.join(room, conn);
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

  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch (_) {}
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

module.exports = { attachBattleCitySignaling };
