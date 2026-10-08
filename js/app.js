/* =============================================
   SNUGGLE — Home Page Interactions
   ============================================= */

(function () {
  'use strict';

  // --- DOM Ready ---
  document.addEventListener('DOMContentLoaded', init);

  function init() {
    // Trigger page load fade-in
    requestAnimationFrame(() => {
      document.body.classList.add('loaded');
    });

    // Setup bottom sheet interactions
    setupBottomSheet();
  }

  // --- Bottom Sheet ---
  function setupBottomSheet() {
    const sheet = document.getElementById('bottom-sheet');
    if (!sheet) return;

    const backdrop = sheet.querySelector('.bottom-sheet__backdrop');
    const titleEl = sheet.querySelector('.bottom-sheet__title');
    const textEl = sheet.querySelector('.bottom-sheet__text');

    // Delegate clicks on info buttons
    document.addEventListener('click', function (e) {
      const infoBtn = e.target.closest('.nav-btn__info');
      if (infoBtn) {
        e.preventDefault();
        e.stopPropagation();

        const title = infoBtn.getAttribute('data-title') || 'Info';
        const description = infoBtn.getAttribute('data-info') || '';

        openSheet(title, description);
      }
    });

    // Close on backdrop click
    if (backdrop) {
      backdrop.addEventListener('click', closeSheet);
    }

    // Close on handle tap
    const handle = sheet.querySelector('.bottom-sheet__handle');
    if (handle) {
      handle.addEventListener('click', closeSheet);
    }

    // Close on Escape key
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && sheet.classList.contains('active')) {
        closeSheet();
      }
    });

    function openSheet(title, description) {
      if (titleEl) titleEl.textContent = title;
      if (textEl) textEl.textContent = description;
      sheet.classList.add('active');

      // Trap focus for accessibility
      sheet.setAttribute('aria-hidden', 'false');
    }

    function closeSheet() {
      sheet.classList.remove('active');
      sheet.setAttribute('aria-hidden', 'true');
    }
  }
})();
