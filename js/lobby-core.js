/* =============================================
   SNUGGLE — Lobby Core
   Shared logic for Create/Join room flows and
   API Key sheets across different sections (YT, Music)
   ============================================= */

'use strict';

class LobbyController {
  constructor(options) {
    this.prefix = options.prefix;
    this.roomUrl = options.roomUrl;
    
    // DOM refs
    this.createBtn = document.getElementById(`${this.prefix}-create-btn`);
    this.joinBtn = document.getElementById(`${this.prefix}-join-btn`);
    this.joinWrap = document.getElementById(`${this.prefix}-join-wrap`);
    this.joinInputArea = document.getElementById(`${this.prefix}-join-input-area`);
    this.codeInput = document.getElementById(`${this.prefix}-room-code-input`);
    this.joinSubmit = document.getElementById(`${this.prefix}-join-submit-btn`);
    this.joinError = document.getElementById(`${this.prefix}-join-error`);
    
    this.overlay = document.getElementById(`${this.prefix}-lobby-overlay`);
    this.overlayText = document.getElementById(`${this.prefix}-overlay-text`);

    this.setupEventListeners();

    if (this.codeInput) {
      const savedCode = localStorage.getItem('snuggle_last_room_code');
      if (savedCode) {
        this.codeInput.value = savedCode;
      }
    }
  }

  setupEventListeners() {
    if (this.createBtn) {
      this.createBtn.addEventListener('click', () => {
        this.setError('');
        window.location.href = `${this.roomUrl}?action=create`;
      });
    }

    if (this.joinBtn) {
      this.joinBtn.addEventListener('click', () => {
        const expanded = this.joinBtn.getAttribute('aria-expanded') === 'true';
        this.joinBtn.setAttribute('aria-expanded', String(!expanded));
        this.joinInputArea.setAttribute('aria-hidden', String(expanded));
        this.joinWrap.classList.toggle('nav-btn--open', !expanded);
        if (!expanded && this.codeInput) {
          if (!this.codeInput.value) {
            setTimeout(() => this.codeInput.focus(), 200);
          }
        }
      });
    }

    if (this.joinSubmit) {
      this.joinSubmit.addEventListener('click', () => this.attemptJoin());
    }

    if (this.codeInput) {
      this.codeInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this.attemptJoin();
      });

      this.codeInput.addEventListener('input', () => {
        this.codeInput.value = this.codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
        this.setError('');
      });
    }
  }

  attemptJoin() {
    if (!this.codeInput) return;
    const code = this.codeInput.value.trim().toUpperCase();
    if (!code || code.length < 4) {
      this.setError('Enter a valid room code (4–6 characters).');
      return;
    }
    this.setError('');
    window.location.href = `${this.roomUrl}?code=${code}`;
  }

  setError(msg) {
    if (this.joinError) {
      this.joinError.textContent = msg;
      this.joinError.style.display = msg ? 'block' : 'none';
    }
  }

  showOverlay(text) {
    if (this.overlayText) this.overlayText.textContent = text;
    if (this.overlay) {
      this.overlay.classList.add('active');
      this.overlay.setAttribute('aria-hidden', 'false');
    }
  }

  hideOverlay() {
    if (this.overlay) {
      this.overlay.classList.remove('active');
      this.overlay.setAttribute('aria-hidden', 'true');
    }
  }
}

class ApiKeySheetController {
  constructor(options) {
    this.prefix = options.prefix;
    this.storageKey = options.storageKey;
    
    this.sheet = document.getElementById(`${this.prefix}-apikey-sheet`);
    this.input = document.getElementById(`${this.prefix}-apikey-input`);
    this.skip = document.getElementById(`${this.prefix}-apikey-skip`);
    this.save = document.getElementById(`${this.prefix}-apikey-save`);
    this.back = document.getElementById(`${this.prefix}-apikey-backdrop`);

    this.setupEventListeners();
  }

  setupEventListeners() {
    if (!this.sheet) return;

    if (this.skip) {
      this.skip.addEventListener('click', () => this.close());
    }

    if (this.save) {
      this.save.addEventListener('click', () => {
        if (this.input) {
          const key = this.input.value.trim();
          if (key) {
            localStorage.setItem(this.storageKey, key);
          }
        }
        this.close();
      });
    }

    if (this.back) {
      this.back.addEventListener('click', () => this.close());
    }
  }

  open() {
    if (this.sheet) {
      this.sheet.classList.add('active');
      this.sheet.setAttribute('aria-hidden', 'false');
      if (this.input) {
        setTimeout(() => this.input.focus(), 300);
      }
    }
  }

  close() {
    if (this.sheet) {
      this.sheet.classList.remove('active');
      this.sheet.setAttribute('aria-hidden', 'true');
    }
  }
}

// Make them available globally
window.LobbyController = LobbyController;
window.ApiKeySheetController = ApiKeySheetController;
