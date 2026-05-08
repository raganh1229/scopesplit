/**
 * Trial Banner Component
 *
 * Renders a persistent amber banner at the top of the page when
 * the user is in trial status. Not dismissible.
 *
 * Usage:
 *   Include this script and call TrialBanner.init({ daysRemaining: 5 });
 *   Or call TrialBanner.hide() to remove it.
 */

var TrialBanner = (function () {
  'use strict';

  var banner = null;

  function init (opts) {
    if (banner) return; // already rendered

    var days = (opts && opts.daysRemaining !== undefined) ? opts.daysRemaining : 7;
    if (days <= 0) return; // trial expired, don't show

    banner = document.createElement('div');
    banner.className = 'trial-banner';
    banner.innerHTML =
      '<div class="trial-banner-inner">' +
        '<span class="trial-banner-text">' +
          '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>' +
          'Free trial &mdash; <strong>' + days + ' day' + (days !== 1 ? 's' : '') + ' remaining</strong>' +
        '</span>' +
        '<a class="trial-banner-link" href="subscribe.html">Subscribe now &rarr;</a>' +
      '</div>';

    // Inject CSS if not already present
    if (!document.getElementById('trialBannerStyles')) {
      var style = document.createElement('style');
      style.id = 'trialBannerStyles';
      style.textContent =
        '.trial-banner {' +
          'background: #FAEEDA;' +
          'border-bottom: 1px solid #F0DFC0;' +
          'position: relative; z-index: 9000;' +
          'width: 100%;' +
        '}' +
        '.trial-banner-inner {' +
          'max-width: 1200px; margin: 0 auto;' +
          'padding: 8px 24px;' +
          'display: flex; align-items: center; justify-content: space-between;' +
          'gap: 12px; flex-wrap: wrap;' +
        '}' +
        '.trial-banner-text {' +
          'display: flex; align-items: center; gap: 8px;' +
          'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;' +
          'font-size: 13px; color: #854F0B;' +
        '}' +
        '.trial-banner-text strong { font-weight: 600; }' +
        '.trial-banner-text svg { flex-shrink: 0; }' +
        '.trial-banner-link {' +
          'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;' +
          'font-size: 13px; font-weight: 600; color: #854F0B;' +
          'text-decoration: none; white-space: nowrap;' +
        '}' +
        '.trial-banner-link:hover { text-decoration: underline; }' +
        '@media (max-width: 480px) {' +
          '.trial-banner-inner { padding: 8px 16px; font-size: 12px; }' +
          '.trial-banner-text { font-size: 12px; }' +
          '.trial-banner-link { font-size: 12px; }' +
        '}';
      document.head.appendChild(style);
    }

    // Insert at the very top of body
    document.body.insertBefore(banner, document.body.firstChild);
  }

  function hide () {
    if (banner && banner.parentNode) {
      banner.parentNode.removeChild(banner);
      banner = null;
    }
  }

  return { init: init, hide: hide };
})();
