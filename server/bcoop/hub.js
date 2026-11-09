'use strict';

/**
 * In-memory room hub for Battle City co-op WebRTC signaling.
 * Matches the protocol expected by `crates/client/src/game.rs` and `crates/signal-proto`:
 *
 * Wire format (JSON text frames):
 *
 * Server -> Client:
 *   {"type":"welcome","slot":0|1,"peer_present":bool,"room":"XYZ"}
 *   {"type":"peer_joined"}
 *   {"type":"peer_left"}
 *   {"type":"signal","data":{...}}
 *   {"type":"error","code":"room_full"|"bad_message"|"rate_limited"|"server_busy","message":"..."}
 *
 * Client -> Server:
 *   {"type":"signal","data":{...}}
 */

const ROOM_CODE_RE = /^[A-Za-z0-9_-]{1,64}$/;

class BattleCityHub {
  constructor(opts = {}) {
    this.maxRooms = opts.maxRooms ?? 10000;
    this.maxMessageBytes = opts.maxMessageBytes ?? 64 * 1024;
    this.rateLimit = opts.rateLimit ?? 100; // max msgs per second
    this.rooms = new Map(); // roomCode -> { slots: [conn0, conn1] }
    this.conns = new WeakMap(); // conn -> { roomCode, slot, lastSecond: number, count: number }
  }

  static isValidRoomCode(code) {
    return typeof code === 'string' && ROOM_CODE_RE.test(code);
  }

  roomCount() {
    return this.rooms.size;
  }

  join(roomCode, conn) {
    if (!BattleCityHub.isValidRoomCode(roomCode)) {
      this._send(conn, { type: 'error', code: 'bad_message', message: 'invalid room code' });
      conn.close(4000, 'invalid room code');
      return false;
    }

    if (this.conns.has(conn)) {
      this._send(conn, { type: 'error', code: 'bad_message', message: 'already joined' });
      return false;
    }

    let room = this.rooms.get(roomCode);
    if (!room) {
      if (this.rooms.size >= this.maxRooms) {
        this._send(conn, { type: 'error', code: 'server_busy', message: 'the server is at capacity, try again shortly' });
        conn.close(4029, 'server busy');
        return false;
      }
      room = { slots: [null, null] };
      this.rooms.set(roomCode, room);
    }

    let slot = -1;
    if (room.slots[0] === null) {
      slot = 0;
    } else if (room.slots[1] === null) {
      slot = 1;
    } else {
      // 1. Clean up any slot occupied by a dead or non-open connection
      const deadIdx = [0, 1].find(i => {
        const c = room.slots[i];
        return !c || (c.ws && c.ws.readyState !== 1);
      });
      if (deadIdx !== undefined) {
        const deadConn = room.slots[deadIdx];
        if (deadConn) {
          try { deadConn.close(4000, 'replaced dead connection'); } catch (_) {}
          this.conns.delete(deadConn);
        }
        room.slots[deadIdx] = null;
        slot = deadIdx;
      }
      // 2. If a player reconnected with matching sessionId, replace their stale slot!
      else if (conn.sessionId && !conn.isSolo) {
        const matchIdx = [0, 1].find(i => {
          const st = this.conns.get(room.slots[i]);
          return st && st.sessionId === conn.sessionId;
        });
        if (matchIdx !== undefined) {
          const oldConn = room.slots[matchIdx];
          this._send(oldConn, { type: 'error', code: 'reconnected', message: 'reconnected from another tab or window' });
          try { oldConn.close(4001, 'reconnected'); } catch (_) {}
          this.conns.delete(oldConn);
          room.slots[matchIdx] = null;
          slot = matchIdx;
        }
      }

      // 3. If a slot is occupied by a solo-peer bot, preempt it so the real player can join
      if (slot === -1 && !conn.isSolo) {
        const soloIdx = [0, 1].find(i => {
          const st = this.conns.get(room.slots[i]);
          return st && st.isSolo;
        });
        if (soloIdx !== undefined) {
          const soloConn = room.slots[soloIdx];
          this._send(soloConn, { type: 'error', code: 'preempted', message: 'a real player has joined' });
          try { soloConn.close(4000, 'preempted by real player'); } catch (_) {}
          this.conns.delete(soloConn);
          room.slots[soloIdx] = null;
          slot = soloIdx;
        }
      }

      // 4. Truly full with 2 active players
      if (slot === -1) {
        this._send(conn, { type: 'error', code: 'room_full', message: 'this room already has two players' });
        conn.close(4003, 'room full');
        return false;
      }
    }

    room.slots[slot] = conn;
    const peerPresent = room.slots[1 - slot] !== null;

    this.conns.set(conn, {
      roomCode,
      slot,
      isSolo: !!conn.isSolo,
      sessionId: conn.sessionId || null,
      windowStart: Date.now(),
      msgCount: 0
    });

    // 1. Send welcome to the newly joined player
    this._send(conn, {
      type: 'welcome',
      slot,
      peer_present: peerPresent,
      room: roomCode
    });

    // 2. Notify existing peer if present
    if (peerPresent) {
      this._send(room.slots[1 - slot], { type: 'peer_joined' });
    }

    return true;
  }

  message(conn, raw) {
    const st = this.conns.get(conn);
    if (!st) return;

    if (typeof raw !== 'string') {
      this._send(conn, { type: 'error', code: 'bad_message', message: 'text frames only' });
      return conn.close(1003, 'text only');
    }

    if (Buffer.byteLength(raw, 'utf8') > this.maxMessageBytes) {
      this._send(conn, { type: 'error', code: 'bad_message', message: 'message too large' });
      return conn.close(1009, 'message too large');
    }

    // Rate limiting
    const now = Date.now();
    if (now - st.windowStart >= 1000) {
      st.windowStart = now;
      st.msgCount = 0;
    }
    st.msgCount++;
    if (st.msgCount > this.rateLimit) {
      this._send(conn, { type: 'error', code: 'rate_limited', message: 'too many messages' });
      return conn.close(4029, 'rate limited');
    }

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return this._send(conn, { type: 'error', code: 'bad_message', message: 'unrecognised message' });
    }

    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      return this._send(conn, { type: 'error', code: 'bad_message', message: 'message must be an object' });
    }

    if (msg.type === 'signal') {
      const room = this.rooms.get(st.roomCode);
      if (!room) return;
      const other = room.slots[1 - st.slot];
      if (other) {
        this._send(other, { type: 'signal', data: msg.data });
      }
    } else {
      this._send(conn, { type: 'error', code: 'bad_message', message: 'unrecognised message type' });
    }
  }

  leave(conn) {
    const st = this.conns.get(conn);
    if (!st) return;
    this.conns.delete(conn);

    const room = this.rooms.get(st.roomCode);
    if (!room) return;

    if (room.slots[st.slot] === conn) {
      room.slots[st.slot] = null;
      const other = room.slots[1 - st.slot];
      if (other) {
        this._send(other, { type: 'peer_left' });
      }
    }

    if (room.slots[0] === null && room.slots[1] === null) {
      this.rooms.delete(st.roomCode);
    }
  }

  _send(conn, obj) {
    try {
      if (conn && typeof conn.send === 'function') {
        conn.send(JSON.stringify(obj));
      }
    } catch (_) {}
  }
}

module.exports = { BattleCityHub, ROOM_CODE_RE };
