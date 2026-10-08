'use strict';

document.addEventListener('DOMContentLoaded', () => {
  document.body.classList.add('loaded');

  const lobbyCtrl = new window.LobbyController({
    prefix: 'connections',
    roomUrl: '/games/connections/game.html'
  });
});
