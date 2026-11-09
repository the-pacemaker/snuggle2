# Contra Co-op Integration & Architecture Guide

This document explains the architecture, server integration, frontend setup, and WebRTC lockstep synchronization of **Contra** integrated into Snuggle using the native Rust WASM lockstep engine from `experiment/Contra (USA).zip` and the Battle City netplay architecture.

---

## 1. System Architecture

Contra runs a deterministic NES emulator compiled to **WebAssembly** in both players' browsers. Player 1 (Bill Rizer 🔵) and Player 2 (Lance Bean 🔴) exchange controller inputs directly over **WebRTC data channels** at 60 FPS in deterministic lockstep.

```
       Browser A (Player 1 / Slot 0)               Browser B (Player 2 / Slot 1)
                 │                                           │
                 │ 1. ws://host/ccoop-signal?room=ROOM       │ 1. ws://host/ccoop-signal?room=ROOM
                 ▼                                           ▼
         Signaling Hub (server/ccoop/ws-adapter.js + hub.js)
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
- **TetaNES Core**: A cycle-accurate NES core with zeroed power-on RAM and pinned emulation settings. Full native support for Mapper 2 (UxROM / UNROM) powering Contra (USA).
- **RNG Determinism**: Enemy movements, bullet spreads, and spawns are pseudo-random sequences driven by synchronized players' controller inputs. Identical inputs across frames guarantee bit-identical gameplay across both browsers.
- **Input Delay**: Default 3 frames (~50 ms) masks network latency seamlessly.
- **State Checksums & Resync**: FNV-1a state hashes are compared every 30 frames; any desync automatically triggers host-authoritative state transfer.

---

## 2. Directory & File Layout

```
snuggle2/
├── server/
│   ├── index.js                     <-- Routes /games/contra, attaches ccoopSignaling
│   ├── sync.js                      <-- Bypasses /ccoop-signal from main sync server
│   └── ccoop/                       <-- Contra signaling backend
│       ├── hub.js                   <-- ContraHub (pairs slot 0 & slot 1, relays SDP/ICE, rate limiting)
│       └── ws-adapter.js            <-- attachContraSignaling (WebSocket upgrade handler on /ccoop-signal)
│
├── games/
│   ├── index.html                   <-- Retro "Contra" button linking to /games/contra/
│   └── contra/                      <-- Frontend client
│       ├── index.html               <-- Snuggle top bar, room sync, status dot, invite button, toast, arcade bezel
│       ├── NES_gamepad.gif          <-- NES controller visual asset
│       ├── pkg/                     <-- Compiled WebAssembly client
│       │   ├── client.js            <-- wasm-bindgen glue, keepalive coordination & mount() export
│       │   ├── client_bg.wasm       <-- Compiled Rust netplay-core + nes-emu client
│       │   ├── client.d.ts
│       │   └── client_bg.wasm.d.ts
│       └── rom/
│           ├── contra.nes           <-- Contra ROM (131,088 bytes, Mapper 2 UxROM, from experiment/Contra (USA).zip)
│           └── Contra (USA).nes     <-- Verified mirror
```

---

## 3. Server-Side Integration Details

### Step 3.1: Signaling Hub (`server/ccoop/hub.js`)
Handles slot pairing, room capacity (max 2 players), and signal forwarding:
- `welcome`: `{ type: "welcome", slot: 0|1, peer_present: bool, room: "..." }`
- `peer_joined`: `{ type: "peer_joined" }`
- `peer_left`: `{ type: "peer_left" }`
- `signal`: `{ type: "signal", data: { kind: "offer"|"answer"|"ice", ... } }`
- `error`: `{ type: "error", code: "room_full"|"bad_message"|"rate_limited", message: "..." }`

### Step 3.2: WebSocket Upgrade Handler (`server/ccoop/ws-adapter.js`)
Attaches to both `httpServer` and `httpsServer` on `/ccoop-signal` and `/contra-signal`.

### Step 3.3: Route & Server Integration (`server/index.js`)
- Exposes `GET /games/contra/` serving `games/contra/index.html`.
- Attaches `attachContraSignaling` on startup.
- Cleans up `ccoopSignaling.close()` on server shutdown.

---

## 4. Frontend Integration & UX Details (`games/contra/index.html`)

- **Retro Arcade Cabinet Aesthetic**:
  - CRT Scanlines & monitor curvature toggleable in real-time (`📺`, shortcut `T`).
  - Glowing status LED, stereo indicators, and real-time P2P ping readout.
- **Commando Briefing & Pre-Game Lobby**:
  - Interactive retro lobby showing Player 1 (Bill Rizer 🔵) and Player 2 (Lance Bean 🔴).
  - Prominent mission code, 1-click clipboard copy, and instant QR code modal for mobile players on the local Wi-Fi network.
  - Slot choice coordination: friend's selection displays a "Friend" badge on their chosen operative.
  - Seamless solo play support: if playing alone, runs smoothly in 1P mode via loopback peer.
- **Responsive On-Screen Touch Controls**:
  - 8-Way virtual analog joystick + D-Pad with diagonal aiming (vital for firing diagonally while running in Contra).
  - Button B (Shoot), Button A (Jump), and dedicated `TURBO` button firing at 10 Hz pulse rate for continuous automatic weapon spray.
  - Center Select and Start buttons.
- **Zero-Dependency Web Audio & Autoplay Recovery**:
  - Automatic detection of browser audio restrictions with one-tap unmute on first gesture.
  - Authentic 8-bit sound generated directly by TetaNES audio pipeline.
- **Plug & Play Physical Gamepads**:
  - Auto-detection for Xbox, PlayStation, Switch Pro, and 8BitDo controllers.
  - Left stick / D-Pad for 8-way aim and run, Button A for Jump, Button B for Shoot, vibration rumble feedback.
- **Weapon Dossier & Konami Code Reference**:
  - Comprehensive weapons intel (Spread Gun, Laser, Machine Gun, Fireball, Barrier, Rapid Fire).
  - 30-Lives Konami Code (`↑ ↑ ↓ ↓ ← → ← → B A Start`).
- **Snuggle Header & Invite Hub**:
  - Dynamic connection dot (`#dot`), room invite pill (`#copy`), and `window.SnuggleInvite.connectHub(roomCode)`.
