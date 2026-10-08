/* =============================================
   SNUGGLE — Local Video Lobby
   Handles Create / Join room and navigation 
   to room.html
   ============================================= */

'use strict';

// ── Init ─────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.body.classList.add('loaded');
  
  const lobbyCtrl = new window.LobbyController({
    prefix: 'localvid',
    roomUrl: '/movies/room.html'
  });
});
