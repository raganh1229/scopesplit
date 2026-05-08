/**
 * ComparisonFilters — filter, sort, and UI logic for the estimate comparison table.
 *
 * React migration map:
 *   state              → useState / useReducer
 *   applyFilters()     → declarative render with .filter() in JSX
 *   handleXxx()        → event handler props updating state
 *   filter predicates  → extract to utils/filters.ts (pure, reusable as-is)
 *   DOM queries        → refs + props
 *   init()             → useEffect on mount
 */
var ComparisonFilters = (function () {
  'use strict';

  /* ============================================
     STATE
     ============================================ */
  var state = {
    status:    { match: true, modified: true, missing: true, added: true },
    search:    '',       // '' = all
    zone:      '',       // '' = all
    category:  '',       // '' = all
    minDiff:   0,        // 0 = all
    sortField: 'default',
    sortDir:   'desc'
  };

  var tbody;

  /* ============================================
     PURE FILTER PREDICATES (copy straight to React)
     ============================================ */
  function matchesStatus(row) {
    return state.status[row.getAttribute('data-status')] === true;
  }

  function matchesZone(row) {
    if (!state.zone) return true;
    return row.getAttribute('data-zone') === state.zone;
  }

  function matchesCategory(row) {
    if (!state.category) return true;
    return row.getAttribute('data-category') === state.category;
  }

  function matchesDiffThreshold(row) {
    if (state.minDiff === 0) return true;
    return Math.abs(parseFloat(row.getAttribute('data-diff')) || 0) >= state.minDiff;
  }

  function matchesSearch(row) {
    if (!state.search) return true;
    var text = row.textContent.toLowerCase();
    return text.indexOf(state.search) !== -1;
  }

  function shouldShow(row) {
    return matchesStatus(row) && matchesSearch(row) && matchesZone(row) &&
           matchesCategory(row) && matchesDiffThreshold(row);
  }

  /* ============================================
     APPLY FILTERS TO DOM
     ============================================ */
  function applyFilters() {
    var rows = tbody.querySelectorAll('tr[data-status]');
    for (var i = 0; i < rows.length; i++) {
      if (shouldShow(rows[i])) {
        rows[i].classList.remove('row-hidden');
      } else {
        rows[i].classList.add('row-hidden');
        rows[i].classList.remove('row-selected');
      }
    }
    syncFilterBadge();
  }

  /* ============================================
     SORT
     ============================================ */
  function applySort() {
    var rows = Array.prototype.slice.call(tbody.querySelectorAll('tr[data-status]'));
    var spacer = tbody.querySelector('.spacer-row');

    rows.sort(function (a, b) {
      if (state.sortField === 'diff') {
        var da = Math.abs(parseFloat(a.getAttribute('data-diff')) || 0);
        var db = Math.abs(parseFloat(b.getAttribute('data-diff')) || 0);
        return state.sortDir === 'desc' ? db - da : da - db;
      }
      return 0;
    });

    for (var i = 0; i < rows.length; i++) {
      tbody.insertBefore(rows[i], spacer);
    }
  }

  /* ============================================
     UI SYNC HELPERS
     ============================================ */
  function syncPills() {
    var pills = document.querySelectorAll('.pill[data-filter]');
    for (var i = 0; i < pills.length; i++) {
      var key = pills[i].getAttribute('data-filter');
      pills[i].classList.toggle('active', !!state.status[key]);
    }
    var link = document.querySelector('.discrepancies-link');
    if (!link) return;
    var allOn = state.status.match && state.status.modified &&
                state.status.missing && state.status.added;
    link.textContent = allOn ? 'Discrepancies only' : 'Show all';
  }

  function syncFilterBadge() {
    var count = 0;
    if (state.zone)       count++;
    if (state.category)   count++;
    if (state.minDiff > 0) count++;
    var btn = document.getElementById('filtersToggleBtn');
    if (!btn) return;
    var badge = btn.querySelector('.filters-badge');
    if (count > 0) {
      badge.textContent = count;
      badge.style.display = 'inline-flex';
    } else {
      badge.style.display = 'none';
    }
  }

  function syncSortArrow() {
    var arrow = document.querySelector('.sort-arrow');
    if (!arrow) return;
    if (state.sortField === 'default') {
      arrow.textContent = '\u2195';
    } else {
      arrow.textContent = state.sortDir === 'desc' ? '\u2193' : '\u2191';
    }
  }

  /* ============================================
     EVENT HANDLERS (map 1-to-1 to React handlers)
     ============================================ */
  function handleStatusToggle(e) {
    var key = e.currentTarget.getAttribute('data-filter');
    state.status[key] = !state.status[key];
    syncPills();
    applyFilters();
  }

  function handleDiscrepanciesShortcut(e) {
    e.preventDefault();
    var allOn = state.status.match && state.status.modified &&
                state.status.missing && state.status.added;
    if (allOn) {
      state.status.match = false;
    } else {
      state.status = { match: true, modified: true, missing: true, added: true };
    }
    syncPills();
    applyFilters();
  }

  function handleFiltersToggle() {
    var panel = document.getElementById('filtersPanel');
    if (!panel) return;
    var isOpen = !panel.hidden;
    panel.hidden = isOpen;
    /* Close columns panel if open */
    var colPanel = document.getElementById('columnsPanel');
    if (colPanel) colPanel.hidden = true;
  }

  function handleZoneChange(e) {
    state.zone = e.target.value;
    applyFilters();
  }

  function handleCategoryChange(e) {
    state.category = e.target.value;
    applyFilters();
  }

  function handleThreshold(e) {
    var val = parseInt(e.currentTarget.getAttribute('data-threshold'), 10) || 0;
    state.minDiff = val;
    var btns = document.querySelectorAll('.threshold-btn');
    for (var i = 0; i < btns.length; i++) {
      var v = parseInt(btns[i].getAttribute('data-threshold'), 10) || 0;
      btns[i].classList.toggle('active', v === val);
    }
    applyFilters();
  }

  /* Search — debounced for performance with large tables */
  var searchTimer = null;
  function handleSearch(e) {
    var val = e.target.value.toLowerCase().trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      state.search = val;
      applyFilters();
    }, 150);
  }

  function handleSortToggle() {
    if (state.sortField === 'diff') {
      if (state.sortDir === 'desc') {
        state.sortDir = 'asc';
      } else {
        state.sortField = 'default';
        state.sortDir = 'desc';
      }
    } else {
      state.sortField = 'diff';
      state.sortDir = 'desc';
    }
    syncSortArrow();
    applySort();
    applyFilters();
  }

  /* ============================================
     INIT
     ============================================ */
  function init() {
    tbody = document.querySelector('.tbl tbody');
    if (!tbody) return;

    /* Status pills — event delegation on container */
    var pillWrap = document.querySelector('.status-pills');
    if (pillWrap) {
      pillWrap.addEventListener('click', function (e) {
        var pill = e.target.closest('.pill[data-filter]');
        if (pill) { handleStatusToggle({ currentTarget: pill }); return; }
      });
    }

    /* Discrepancies link — direct binding (lives outside pill container) */
    var discLink = document.querySelector('.discrepancies-link');
    if (discLink) discLink.addEventListener('click', handleDiscrepanciesShortcut);

    /* Filters toggle */
    var fBtn = document.getElementById('filtersToggleBtn');
    if (fBtn) fBtn.addEventListener('click', handleFiltersToggle);

    /* Search input */
    var searchEl = document.getElementById('searchInput');
    if (searchEl) searchEl.addEventListener('input', handleSearch);

    /* Secondary filter controls */
    var zoneEl = document.getElementById('zoneFilter');
    if (zoneEl) zoneEl.addEventListener('change', handleZoneChange);

    var catEl = document.getElementById('categoryFilter');
    if (catEl) catEl.addEventListener('change', handleCategoryChange);

    /* Threshold — delegation */
    var threshWrap = document.querySelector('.threshold-group');
    if (threshWrap) {
      threshWrap.addEventListener('click', function (e) {
        var btn = e.target.closest('.threshold-btn');
        if (btn) handleThreshold({ currentTarget: btn });
      });
    }

    /* Sort header — delegated because column labels row is rebuilt on column toggle */
    var thead = document.querySelector('.tbl thead');
    if (thead) thead.addEventListener('click', function (e) {
      var sortEl = e.target.closest('.diff-sort');
      if (sortEl) handleSortToggle();
    });

    /* Initial UI sync */
    syncPills();
    syncFilterBadge();
    syncSortArrow();
  }

  /* ============================================
     PUBLIC API
     ============================================ */
  return {
    init: init,
    applyAll: applyFilters,
    getState: function () { return JSON.parse(JSON.stringify(state)); },
    predicates: { matchesStatus: matchesStatus, matchesSearch: matchesSearch,
                  matchesZone: matchesZone, matchesCategory: matchesCategory,
                  matchesDiffThreshold: matchesDiffThreshold }
  };
})();

document.addEventListener('DOMContentLoaded', ComparisonFilters.init);
