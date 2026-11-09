'use strict';

/**
 * Mint a join token for the Rust signaling service (signaling/).
 *
 * Call this from your lobby when a player is allowed into a room, and hand the
 * token to the browser alongside the room code. The signaling service verifies it
 * with the same secret (COOP_SIGNAL_SECRET) and never talks to the lobby.
 *
 *   const { mintToken } = require('./lobby/mint-token');
 *   const token = mintToken({ secret, room: 'ABC123', seat: 'host', ttlSeconds: 120 });
 *   // browser: new RoomTransport({ signalUrl, roomCode: 'ABC123', token, ... })
 *
 * seat: 'host' = player 1, 'guest' = player 2, 'any' = first free slot.
 * Keep ttlSeconds short (the token only has to survive until the socket opens).
 *
 * CLI:  COOP_SIGNAL_SECRET=... node mint-token.js ROOM host 120
 */

const crypto = require('node:crypto');

const ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SEATS = new Set(['host', 'guest', 'any']);

function mintToken({ secret, room, seat = 'any', ttlSeconds = 120, now = Date.now() }) {
  if (!secret) throw new Error('secret required');
  if (!ROOM_RE.test(room)) throw new Error('invalid room code');
  if (!SEATS.has(seat)) throw new Error("seat must be 'host', 'guest' or 'any'");
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) throw new Error('ttlSeconds must be a positive integer');
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const sig = crypto.createHmac('sha256', secret).update(`v1\n${room}\n${seat}\n${exp}`).digest('hex');
  return `v1.${seat}.${exp}.${sig}`;
}

function verifyToken({ secret, room, token, now = Date.now() }) {
  if (!secret || !token) return false;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return false;
  const [_, seat, expStr, sig] = parts;
  if (!SEATS.has(seat)) return false;
  const exp = parseInt(expStr, 10);
  if (isNaN(exp) || exp < Math.floor(now / 1000)) return false;
  const expectedSig = crypto.createHmac('sha256', secret).update(`v1\n${room}\n${seat}\n${exp}`).digest('hex');
  if (sig !== expectedSig) return false;
  return { seat: seat === 'any' ? undefined : seat };
}

module.exports = { mintToken, verifyToken };

if (require.main === module) {
  const [room, seat, ttl] = process.argv.slice(2);
  try {
    process.stdout.write(mintToken({ secret: process.env.COOP_SIGNAL_SECRET, room, seat, ttlSeconds: ttl ? Number(ttl) : 120 }));
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
}
