'use strict';

/**
 * Room hub for WebRTC signaling. Pure logic, no dependencies: a "connection"
 * is anything with `send(string)` and `close(code, reason)`. `ws-adapter.js`
 * wires real WebSockets to this; tests wire in-memory fakes.
 *
 * Each room has two slots. The host slot is player 1 (authoritative for
 * desync repair); the guest slot is player 2. The lobby may force which slot
 * a user takes (`join(code, conn, { role })`), otherwise the first free slot
 * is used, host first.
 *
 * Server -> client messages (JSON):
 *   {type:'joined', room, role, peerPresent, iceServers}
 *   {type:'peer-joined'} {type:'peer-left'}
 *   {type:'signal', data}          relayed verbatim from the other peer
 *   {type:'error', code, message}
 * Client -> server messages:
 *   {type:'signal', data}          data = SDP / ICE JSON, any object
 *   {type:'ping'}                  answered with {type:'pong'}
 */

const ROOM_CODE_RE = /^[A-Za-z0-9_-]{1,64}$/;

const CLOSE = Object.freeze({
  BAD_ROOM: 4000,
  ROOM_FULL: 4003,
  SLOT_TAKEN: 4004,
  BAD_MESSAGE: 4008,
  TOO_LARGE: 4009,
  ALREADY_JOINED: 4010,
  RATE_LIMITED: 4029,
});

let DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
try {
  const { DEFAULT_ICE_SERVERS } = require('../ice-servers');
  if (Array.isArray(DEFAULT_ICE_SERVERS) && DEFAULT_ICE_SERVERS.length > 0) {
    DEFAULT_ICE = DEFAULT_ICE_SERVERS;
  }
} catch (_) {}

class RoomHub {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxMessageBytes=16384]  largest accepted client message
   * @param {number} [opts.maxStrikes=5]           malformed messages tolerated per connection
   * @param {number} [opts.burst=60]               rate-limit bucket size (messages)
   * @param {number} [opts.perSecond=30]           rate-limit refill
   * @param {Array|Function} [opts.iceServers]     array, or (room, role) => array for per-user TURN creds
   * @param {Function} [opts.now]                  clock, injectable for tests
   * @param {Function} [opts.log]                  (event, details) => void
   */
  constructor(opts = {}) {
    this.maxMessageBytes = opts.maxMessageBytes ?? 16 * 1024;
    this.maxStrikes = opts.maxStrikes ?? 5;
    this.burst = opts.burst ?? 60;
    this.perSecond = opts.perSecond ?? 30;
    this.iceServers = opts.iceServers ?? DEFAULT_ICE;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    /** @type {Map<string, {host: object|null, guest: object|null}>} */
    this.rooms = new Map();
    /** @type {WeakMap<object, object>} conn -> state */
    this.conns = new WeakMap();
  }

  static isValidRoomCode(code) {
    return typeof code === 'string' && ROOM_CODE_RE.test(code);
  }

  roomCount() {
    return this.rooms.size;
  }

  /** Returns {ok:true, role} or {ok:false, code, reason}; on failure the conn is closed. */
  join(room, conn, { role } = {}) {
    if (!RoomHub.isValidRoomCode(room)) return this._reject(conn, CLOSE.BAD_ROOM, 'invalid room code');
    if (role !== undefined && role !== 'host' && role !== 'guest') {
      return this._reject(conn, CLOSE.BAD_ROOM, 'invalid role');
    }
    if (this.conns.has(conn)) return this._reject(conn, CLOSE.ALREADY_JOINED, 'already joined');

    let r = this.rooms.get(room);
    if (!r) r = { host: null, guest: null };

    let slot;
    if (role) {
      if (r[role]) return this._reject(conn, CLOSE.SLOT_TAKEN, `${role} slot already taken`);
      slot = role;
    } else if (!r.host) slot = 'host';
    else if (!r.guest) slot = 'guest';
    else return this._reject(conn, CLOSE.ROOM_FULL, 'room full');

    r[slot] = conn;
    this.rooms.set(room, r);
    this.conns.set(conn, {
      room,
      role: slot,
      tokens: this.burst,
      last: this.now(),
      strikes: 0,
    });

    const other = this._peerOf(room, slot);
    this._send(conn, {
      type: 'joined',
      room,
      role: slot,
      peerPresent: !!other,
      iceServers: this._ice(room, slot),
    });
    if (other) this._send(other, { type: 'peer-joined' });
    this.log('join', { room, role: slot, peerPresent: !!other });
    return { ok: true, role: slot };
  }

  /** Feed one raw text message from a connection. */
  message(conn, raw) {
    const st = this.conns.get(conn);
    if (!st) return;
    if (typeof raw !== 'string') return this._strike(conn, st, 'binary frames are not accepted');
    // Byte length, not UTF-16 length: a hostile client can hide a lot in multi-byte text.
    if (Buffer.byteLength(raw, 'utf8') > this.maxMessageBytes) {
      this._send(conn, { type: 'error', code: 'too-large', message: 'message too large' });
      return conn.close(CLOSE.TOO_LARGE, 'message too large');
    }
    if (!this._takeToken(st)) {
      this._send(conn, { type: 'error', code: 'rate-limited', message: 'slow down' });
      return conn.close(CLOSE.RATE_LIMITED, 'rate limited');
    }

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return this._strike(conn, st, 'invalid JSON');
    }
    if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
      return this._strike(conn, st, 'message must be an object');
    }

    switch (msg.type) {
      case 'ping':
        this._send(conn, { type: 'pong' });
        return;
      case 'signal': {
        if (msg.data === null || typeof msg.data !== 'object') {
          return this._strike(conn, st, 'signal needs an object payload');
        }
        const other = this._peerOf(st.room, st.role);
        if (!other) {
          this._send(conn, { type: 'error', code: 'no-peer', message: 'no peer in room yet' });
          return;
        }
        this._send(other, { type: 'signal', data: msg.data });
        return;
      }
      default:
        return this._strike(conn, st, `unknown message type`);
    }
  }

  /** Call when a connection closes for any reason. Idempotent. */
  leave(conn) {
    const st = this.conns.get(conn);
    if (!st) return;
    this.conns.delete(conn);
    const r = this.rooms.get(st.room);
    if (!r) return;
    if (r[st.role] === conn) r[st.role] = null;
    const other = r.host || r.guest;
    if (other) this._send(other, { type: 'peer-left' });
    else this.rooms.delete(st.room);
    this.log('leave', { room: st.room, role: st.role });
  }

  // ---------------------------------------------------------------- internals

  _peerOf(room, role) {
    const r = this.rooms.get(room);
    if (!r) return null;
    return role === 'host' ? r.guest : r.host;
  }

  _ice(room, role) {
    try {
      return typeof this.iceServers === 'function' ? this.iceServers(room, role) : this.iceServers;
    } catch (e) {
      this.log('ice-error', { error: String(e) });
      return DEFAULT_ICE;
    }
  }

  _send(conn, obj) {
    try {
      conn.send(JSON.stringify(obj));
    } catch (e) {
      // A dead socket must never take the hub down; its close handler cleans up.
      this.log('send-failed', { error: String(e) });
    }
  }

  _reject(conn, code, reason) {
    this._send(conn, { type: 'error', code: 'rejected', message: reason });
    try {
      conn.close(code, reason);
    } catch {
      /* already closed */
    }
    return { ok: false, code, reason };
  }

  _strike(conn, st, why) {
    st.strikes += 1;
    this._send(conn, { type: 'error', code: 'bad-message', message: why });
    if (st.strikes >= this.maxStrikes) conn.close(CLOSE.BAD_MESSAGE, 'too many bad messages');
  }

  _takeToken(st) {
    const t = this.now();
    const elapsed = Math.max(0, t - st.last) / 1000;
    st.last = t;
    st.tokens = Math.min(this.burst, st.tokens + elapsed * this.perSecond);
    if (st.tokens < 1) return false;
    st.tokens -= 1;
    return true;
  }
}

module.exports = { RoomHub, CLOSE, ROOM_CODE_RE, DEFAULT_ICE };
