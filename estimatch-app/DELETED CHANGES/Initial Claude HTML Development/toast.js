/**
 * Toast Notification System
 *
 * Usage:
 *   Toast.success('Comparison saved successfully.');
 *   Toast.error('Upload failed. Please try a different file.');
 *   Toast.info('Your plan renews on May 1, 2026.');
 *   Toast.warning('You have 2 comparisons remaining this month.');
 *
 * With title:
 *   Toast.success('Comparison saved', 'You can view it in your comparisons list.');
 *
 * With options:
 *   Toast.error('Upload failed.', { autoDismiss: false });
 *   Toast.warning('Limit reached', { message: 'Upgrade for more.', linkText: 'Upgrade', linkHref: 'subscribe.html' });
 *
 * Manual dismiss:
 *   Toast.error('Subscription canceled', { autoDismiss: false, message: 'You will have access until June 1.' });
 */

var Toast = (function () {
  'use strict';

  var MAX_VISIBLE = 3;

  var DURATIONS = {
    success: 7000,
    info:    7000,
    warning: 10000,
    error:   0       // 0 = manual dismiss only
  };

  var ICONS = {
    success: '<svg viewBox="0 0 24 24"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
    error:   '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    info:    '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
    warning: '<svg viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'
  };

  var container = null;
  var toasts = [];

  function ensureContainer () {
    if (container) return;
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  function createToast (type, titleOrMsg, options) {
    ensureContainer();

    // Normalize arguments: (type, message) or (type, title, { message })
    var title = '';
    var message = '';
    var opts = {};

    if (typeof options === 'string') {
      // Toast.success('Title', 'Message')
      title = titleOrMsg;
      message = options;
    } else if (typeof options === 'object' && options !== null) {
      title = titleOrMsg;
      message = options.message || '';
      opts = options;
    } else {
      message = titleOrMsg;
    }

    var autoDismiss = opts.autoDismiss !== undefined ? opts.autoDismiss : (DURATIONS[type] > 0);
    var duration = opts.duration || DURATIONS[type];

    // Enforce max visible
    while (toasts.length >= MAX_VISIBLE) {
      removeToast(toasts[0]);
    }

    var el = document.createElement('div');
    el.className = 'toast toast--' + type;
    el.style.position = 'relative';

    var html = '';
    html += '<div class="toast-icon">' + ICONS[type] + '</div>';
    html += '<div class="toast-content">';
    if (title) html += '<div class="toast-title">' + title + '</div>';
    html += '<div class="toast-message">' + message;
    if (opts.linkText && opts.linkHref) {
      html += ' <a href="' + opts.linkHref + '">' + opts.linkText + '</a>';
    }
    html += '</div></div>';
    html += '<button class="toast-dismiss" aria-label="Dismiss">';
    html += '<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    html += '</button>';

    if (autoDismiss && duration > 0) {
      html += '<div class="toast-progress"><div class="toast-progress-bar" style="animation-duration:' + duration + 'ms;"></div></div>';
    }

    el.innerHTML = html;

    // Dismiss click
    el.querySelector('.toast-dismiss').addEventListener('click', function () {
      removeToast(el);
    });

    container.appendChild(el);
    toasts.push(el);

    // Auto dismiss timer
    if (autoDismiss && duration > 0) {
      el._timer = setTimeout(function () {
        removeToast(el);
      }, duration);
    }

    return el;
  }

  function removeToast (el) {
    if (!el || !el.parentNode) return;
    if (el._timer) clearTimeout(el._timer);
    el.classList.add('removing');
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
      var idx = toasts.indexOf(el);
      if (idx > -1) toasts.splice(idx, 1);
    }, 250);
  }

  return {
    success: function (titleOrMsg, options) { return createToast('success', titleOrMsg, options); },
    error:   function (titleOrMsg, options) { return createToast('error',   titleOrMsg, options); },
    info:    function (titleOrMsg, options) { return createToast('info',    titleOrMsg, options); },
    warning: function (titleOrMsg, options) { return createToast('warning', titleOrMsg, options); },
    dismiss: removeToast
  };
})();
