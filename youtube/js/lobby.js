/* =============================================
   SNUGGLE — YouTube Lobby
   Handles Create / Join room, API key setup, 
   and navigation to room.html
   ============================================= */

'use strict';

const API_KEY_STORAGE = 'snuggle_yt_apikey';

// ── Init ─────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.body.classList.add('loaded');
  
  const lobbyCtrl = new window.LobbyController({
    prefix: 'yt',
    roomUrl: '/youtube/room.html'
  });

  const apiKeySheetCtrl = new window.ApiKeySheetController({
    prefix: 'yt',
    storageKey: API_KEY_STORAGE
  });

  checkApiKey(apiKeySheetCtrl);
});

function checkApiKey(apiKeySheetCtrl) {
  // API key is hardcoded — no setup needed
  // Sheet remains available in case user wants to override with their own key
}
