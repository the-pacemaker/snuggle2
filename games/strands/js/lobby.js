'use strict';

document.addEventListener('DOMContentLoaded', () => {
  document.body.classList.add('loaded');

  const lobbyCtrl = new window.LobbyController({
    prefix: 'strands',
    roomUrl: '/games/strands/game.html'
  });
});
