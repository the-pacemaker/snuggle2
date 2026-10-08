'use strict';

document.addEventListener('DOMContentLoaded', () => {
  document.body.classList.add('loaded');
  
  const lobbyCtrl = new window.LobbyController({
    prefix: 'wordle',
    roomUrl: '/games/wordle/game.html'
  });
});
