'use strict';

/**
 * Centralized ICE (STUN/TURN) Server Configuration
 *
 * Provides STUN servers for direct NAT traversal and TURN relay servers
 * to ensure WebRTC connectivity even behind symmetric NATs or restrictive firewalls.
 *
 * Configurable via environment variables:
 * - ICE_SERVERS: Complete JSON array string of RTCIceServer objects
 * - TURN_URLS / TURN_URL / TURN_SERVER: Comma-separated TURN URLs (e.g. "turn:relay.example.com:3478,turns:relay.example.com:5349")
 * - TURN_USERNAME: Username for TURN authentication
 * - TURN_CREDENTIAL / TURN_PASSWORD / TURN_SECRET: Password/credential for TURN authentication
 *
 * Defaults to Google & Twilio STUN servers + Metered Open Relay Project TURN servers.
 */

const DEFAULT_ICE_SERVERS = [
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
];

function getIceServers() {
  // 1. If a full JSON array is provided in ICE_SERVERS
  if (process.env.ICE_SERVERS) {
    try {
      const parsed = JSON.parse(process.env.ICE_SERVERS);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    } catch (e) {
      console.warn('[ICE] Failed to parse ICE_SERVERS environment variable as JSON:', e.message);
    }
  }

  // 2. If custom TURN server URLs are specified via environment variables
  const turnUrlsStr = process.env.TURN_URLS || process.env.TURN_URL || process.env.TURN_SERVER;
  if (turnUrlsStr) {
    const urls = turnUrlsStr.split(',').map((u) => u.trim()).filter(Boolean);
    const username = process.env.TURN_USERNAME || '';
    const credential = process.env.TURN_CREDENTIAL || process.env.TURN_PASSWORD || process.env.TURN_SECRET || '';

    const customIce = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' }
    ];

    const turnEntry = { urls };
    if (username) turnEntry.username = username;
    if (credential) turnEntry.credential = credential;

    customIce.push(turnEntry);
    return customIce;
  }

  // 3. Fallback to default STUN + Open Relay Project TURN servers
  return DEFAULT_ICE_SERVERS;
}

module.exports = {
  DEFAULT_ICE_SERVERS,
  getIceServers
};
