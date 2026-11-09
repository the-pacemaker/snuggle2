# Battle City Co-op Integration & Architecture Guide

This document explains the architecture, server integration, frontend setup, and WebRTC lockstep synchronization of **Battle City** integrated into Snuggle from `experiment/battle-city-coop.tar.gz`.

---

## 1. System Architecture

Battle City runs a deterministic NES emulator compiled to **WebAssembly** in both players' browsers. Player 1 and Player 2 exchange controller inputs directly over **WebRTC data channels** at 60 FPS in deterministic lockstep.

```
       Browser A (Player 1 / Slot 0)               Browser B (Player 2 / Slot 1)
                 │                                           │
                 │ 1. ws://host/bcoop-signal?room=ROOM       │ 1. ws://host/bcoop-signal?room=ROOM
                 ▼                                           ▼
         Signaling Hub (server/bcoop/ws-adapter.js + hub.js)
                 │ ◀────────── SDP Offer / Answer ─────────▶ │
                 │ ◀──────────── ICE Candidates ───────────▶ │
                 │                                           │
                 └── WebSocket signaling closes / idle ──────┘
                                   │
              Direct WebRTC Data Channels (2 pre-negotiated)
                 * Channel 0 'control' (ordered, reliable: handshake, checksums, state transfer)
                 * Channel 1 'input'   (unordered, maxRetransmits: 0: 60 FPS input pad bytes)
                 ◀═══════════════════════════════════════════▶
```

### Deterministic Lockstep Emulation
- **TetaNES Core**: A cycle-accurate NES core with zeroed power-on RAM and pinned emulation settings.
- **RNG Determinism**: Enemy tanks pick headings using a pseudo-random LFSR stirred by players' input bytes. Identical inputs across frames guarantee bit-identical enemy movements across both browsers.
- **Input Delay**: Default 3 frames (~50 ms) masks network latency.
- **State Checksums & Resync**: FNV-1a state hashes are compared every 30 frames; any desync automatically triggers a host-authoritative state transfer.

---

## 2. Directory & File Layout

```
snuggle2/
├── server/
│   ├── index.js                     <-- Routes /games/battle-city, attaches bcoopSignaling
│   ├── sync.js                      <-- Bypasses /bcoop-signal and /ws from main sync server
│   └── bcoop/                       <-- Battle City signaling backend
│       ├── hub.js                   <-- BattleCityHub (pairs slot 0 & slot 1, relays SDP/ICE, rate limiting)
│       └── ws-adapter.js            <-- attachBattleCitySignaling (WebSocket upgrade handler on /bcoop-signal & /ws)
│
├── games/
│   ├── index.html                   <-- Updated Retro "Battle City" button to link to /games/battle-city/
│   └── battle-city/                 <-- Frontend client
│       ├── index.html               <-- Snuggle top bar, room sync, status dot, invite button, toast
│       ├── pkg/                     <-- Compiled WebAssembly client
│       │   ├── client.js            <-- wasm-bindgen glue & mount() export
│       │   ├── client_bg.wasm       <-- Compiled Rust netplay-core + nes-emu client
│       │   ├── client.d.ts
│       │   └── client_bg.wasm.d.ts
│       └── rom/
│           ├── battle-city.nes      <-- Battle City ROM (extracted from experiment/BattleCity (Asia) (En) (LA40) (Pirate).zip)
│           └── testrom.nes          <-- Assembled mapper 0 test ROM (backup)
```

---

## 3. Server-Side Integration Details

### Step 3.1: Signaling Hub (`server/bcoop/hub.js`)
Handles slot pairing, room capacity (max 2 players), and signal forwarding:
- `welcome`: `{ type: "welcome", slot: 0|1, peer_present: bool, room: "..." }`
- `peer_joined`: `{ type: "peer_joined" }`
- `peer_left`: `{ type: "peer_left" }`
- `signal`: `{ type: "signal", data: { kind: "offer"|"answer"|"ice", ... } }`
- `error`: `{ type: "error", code: "room_full"|"bad_message"|"rate_limited", message: "..." }`

### Step 3.2: WebSocket Upgrade Handler (`server/bcoop/ws-adapter.js`)
Attaches to both `httpServer` and `httpsServer` on `/bcoop-signal` and `/ws`.

### Step 3.3: Route & Server Integration (`server/index.js`)
- Exposes `GET /games/battle-city/` serving `games/battle-city/index.html`.
- Attaches `attachBattleCitySignaling` on startup.
- Cleans up `bcoopSignaling.close()` on server shutdown.

---

## 4. Frontend Integration & Impeccable UX Details (`games/battle-city/index.html`)

- **Retro Arcade Cabinet Aesthetic**:
  - CRT Scanlines & monitor curvature shader toggleable in real-time (`CRT 📺`, shortcut `T`).
  - Bezel chassis with glowing status LED, stereo indicators, and real-time P2P ping readout.
- **Tank Commander Briefing & Waiting Hangar**:
  - Replaces blank black screens with an interactive retro lobby showing Player 1 (Yellow Tank 🟡) and Player 2 (Green Tank 🟢).
  - Prominent mission code, 1-click clipboard copy, and instant QR code modal for mobile players on the local Wi-Fi network.
  - High-energy transition into active lockstep when partner connects.
- **Direct-Tap 4-Way D-Pad & Turbo Auto-Fire**:
  - Instant direct-tap steering on cardinal directions without requiring thumb drag.
  - Directional hysteresis preventing jitter around brick corners.
  - Dedicated `TURBO` button firing at 10 Hz pulse rate to prevent thumb fatigue on mobile.
- **Zero-Dependency Web Audio 8-Bit Synth & Autoplay Recovery**:
  - Automatic detection of browser audio restrictions with a one-tap unmute prompt.
  - Authentic 8-bit square wave beeps, chimes, and fanfare synthesized directly via the Web Audio API.
- **Plug & Play Physical Gamepads**:
  - Auto-detection for Xbox, PlayStation, Switch Pro, and 8BitDo controllers.
  - Live keymap diagram and vibration rumble (`gamepad.vibrationActuator`).
- **Tank Encyclopedia & Co-op Field Guide**:
  - Comprehensive enemy tank dossier (Basic, Fast Raider, Rapid Cannon, Heavy Armor).
  - Supply drop vault (Star, Shovel, Grenade, Clock, Helmet, Tank).
- **Accurate Pause vs Micro-Stall Handling**:
  - Distinguishes between actual tab pausing (`snuggle_pause` channel) and transient 1-frame network buffer catch-ups (`Syncing frames…`), eliminating confusing "GAME PAUSED" screen flickers.
- **Snuggle Header & Invite Hub**:
  - Dynamic connection dot (`#dot`), room invite pill (`#invite-btn`), and `window.SnuggleInvite.connectHub(roomCode)`.

---

## 5. Testing & Verification

1. **HTTP Endpoints**:
   - `GET /games/battle-city/` returns 200 OK with HTML content.
   - `GET /games/battle-city/pkg/client_bg.wasm` returns 200 OK.
   - `GET /games/battle-city/rom/battle-city.nes` returns 200 OK.
2. **WebSocket Signaling**:
   - Client connects to `/bcoop-signal?room=TEST` -> receives `welcome` frame with `slot: 0`.
   - Second client connects to same room -> receives `welcome` frame with `slot: 1, peer_present: true`, and first client receives `peer_joined`.
   - WebRTC SDP offer/answer/ICE candidates relay verbatim between players.
3. **P2P Gameplay**:
   - Both emulators boot the ROM, synchronize inputs over RTCDataChannel, and render to canvas at 60 FPS.
