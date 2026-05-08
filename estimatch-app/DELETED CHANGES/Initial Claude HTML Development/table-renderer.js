/* ============================================================
   Table Renderer + Column Manager
   
   Reads MockEstimateData, builds the comparison table tbody,
   and manages toggleable cost-breakdown columns.
   
   Key design: only cells for VISIBLE cost columns are created.
   Toggling a column re-renders the entire table (fast for <100
   rows, correct alignment guaranteed).
   ============================================================ */

var TableRenderer = (function () {

  /* ── Colour map for row status backgrounds ── */
  var STATUS_BG = {
    match:    'var(--green-50)',
    modified: 'var(--red-50)',
    missing:  'var(--red-50)',
    added:    'var(--blue-50)'
  };

  /* ── State ── */
  var visibleCosts = [];   // e.g. ['tax', 'op']
  var currentData  = null; // stored for re-render on column toggle

  /* ── Base width config (percentages) ── */
  var WIDTH = {
    zone: 3.5,
    qty: 5,
    costCol: 4,
    total: 7,
    diffTotal: 6,
    diffCost: 4
  };

  /* ── Helpers ── */
  function fmt(val) {
    if (val === 0 || val == null) return null;
    var abs = Math.abs(val);
    var s = '$' + abs.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return val < 0 ? '\u2212' + s : s;
  }

  function fmtDiff(val) {
    if (val === 0 || val == null) return { text: '\u2014', color: '#888780' };
    var abs = Math.abs(val);
    var s = '$' + abs.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    if (val > 0) return { text: '+' + s, color: 'var(--green-600)' };
    return { text: '\u2212' + s, color: 'var(--red-600)' };
  }

  function fmtCostCell(val) {
    if (val === 0 || val == null) return '\u2014';
    return '$' + val.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function el(tag, attrs, content) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'style' && typeof attrs[k] === 'object') {
        for (var s in attrs[k]) e.style[s] = attrs[k][s];
      } else if (k === 'className') {
        e.className = attrs[k];
      } else {
        e.setAttribute(k, attrs[k]);
      }
    }
    if (content !== undefined && content !== null) {
      if (typeof content === 'string') e.innerHTML = content;
      else if (content.nodeType) e.appendChild(content);
    }
    return e;
  }

  /* ── Detect which cost columns have non-zero data ── */
  function detectAvailableCosts(data) {
    var available = {};
    data.zones.forEach(function (zone) {
      zone.items.forEach(function (item) {
        ['your', 'adjuster'].forEach(function (side) {
          if (!item[side]) return;
          data.costColumns.forEach(function (col) {
            if (item[side][col.key] && item[side][col.key] !== 0) {
              available[col.key] = true;
            }
          });
        });
      });
    });
    return data.costColumns.filter(function (col) {
      return available[col.key];
    });
  }

  /* ── Build a standard cell ── */
  function makeCell(text, opts) {
    opts = opts || {};
    var style = {
      padding: opts.padding || '12px 8px',
      borderBottom: '1px solid var(--border-light)'
    };
    if (opts.align)       style.textAlign   = opts.align;
    if (opts.color)       style.color       = opts.color;
    if (opts.fontWeight)  style.fontWeight  = opts.fontWeight;
    if (opts.fontStyle)   style.fontStyle   = opts.fontStyle;
    if (opts.fontSize)    style.fontSize    = opts.fontSize;
    var td = el('td', { style: style }, text);
    if (opts.className) td.className = opts.className;
    if (opts.colspan)   td.colSpan = opts.colspan;
    return td;
  }

  /* ── Append cost cells for one side of a row ── */
  function appendCostCells(tr, sideData, txtColor) {
    visibleCosts.forEach(function (key) {
      var val = sideData ? (sideData[key] || 0) : 0;
      tr.appendChild(makeCell(fmtCostCell(val), {
        align: 'right',
        color: txtColor || (val === 0 ? '#888780' : null)
      }));
    });
  }

  /* ── Append cost diff cells ── */
  function appendCostDiffs(tr, item) {
    visibleCosts.forEach(function (key) {
      var yourVal = item.your ? (item.your[key] || 0) : 0;
      var adjVal  = item.adjuster ? (item.adjuster[key] || 0) : 0;
      var d = fmtDiff(adjVal - yourVal);
      tr.appendChild(makeCell(d.text, {
        align: 'right', fontWeight: '500', color: d.color,
        className: 'diff-border'
      }));
    });
  }

  /* ── Build one data row ── */
  function buildDataRow(item, zone) {
    var tr = document.createElement('tr');
    tr.style.background = STATUS_BG[item.status];
    tr.setAttribute('data-status', item.status);
    tr.setAttribute('data-zone', zone.id);
    tr.setAttribute('data-category', item.category);

    var yourTotal = item.your ? item.your.total : 0;
    var adjTotal  = item.adjuster ? item.adjuster.total : 0;
    var totalDiff = adjTotal - yourTotal;
    tr.setAttribute('data-diff', totalDiff.toString());

    /* ── YOUR SIDE ── */
    if (item.your) {
      tr.appendChild(makeCell(item.your.description, { padding: '12px 16px' }));
      tr.appendChild(makeCell(zone.yourName, { color: 'var(--text-secondary)', fontSize: '12px' }));
      tr.appendChild(makeCell(item.your.qty, { align: 'right' }));
      appendCostCells(tr, item.your, null);
      var totalText = item.your.totalDisplay || fmt(item.your.total) || '$0.00';
      var extra = item.your.totalDisplay ? { color: 'var(--text-secondary)', fontStyle: 'italic' } : {};
      tr.appendChild(makeCell(totalText, Object.assign({ align: 'right', fontWeight: '500', className: 'center-border' }, extra)));
    } else {
      tr.appendChild(makeCell('', { padding: '12px 16px' }));
      tr.appendChild(makeCell('', {}));
      tr.appendChild(makeCell('', { align: 'right' }));
      appendCostCells(tr, null, null);
      tr.appendChild(makeCell('', { align: 'right', className: 'center-border' }));
    }

    /* ── ADJUSTER SIDE ── */
    if (item.adjuster) {
      var txtColor = item.status === 'added' ? 'var(--blue-800)' : null;
      tr.appendChild(makeCell(item.adjuster.description, { padding: '12px 16px', color: txtColor }));
      tr.appendChild(makeCell(zone.adjusterName, { color: 'var(--text-secondary)', fontSize: '12px' }));
      var qtyDiffers = item.your && item.your.qty !== item.adjuster.qty && item.status === 'modified';
      tr.appendChild(makeCell(item.adjuster.qty, {
        align: 'right',
        color: qtyDiffers ? 'var(--red-600)' : txtColor,
        fontWeight: qtyDiffers ? '500' : null
      }));
      appendCostCells(tr, item.adjuster, txtColor);
      tr.appendChild(makeCell(fmt(item.adjuster.total) || '$0.00', {
        align: 'right', fontWeight: '500', color: txtColor
      }));
    } else {
      var missingHtml = '<svg width="14" height="14" viewBox="0 0 16 16" style="vertical-align:-2px;margin-right:4px;">' +
        '<circle cx="8" cy="8" r="7" fill="none" stroke="#A32D2D" stroke-width="1.5"/>' +
        '<path d="M5 8 L11 8" stroke="#A32D2D" stroke-width="1.5" stroke-linecap="round"/></svg>' +
        'Not in adjuster\u2019s estimate';
      tr.appendChild(makeCell(missingHtml, { padding: '12px 16px', color: 'var(--red-600)', fontStyle: 'italic' }));
      tr.appendChild(makeCell('', {}));
      tr.appendChild(makeCell('', { align: 'right' }));
      appendCostCells(tr, null, null);
      tr.appendChild(makeCell('', { align: 'right' }));
    }

    /* ── DIFF AREA ── */
    appendCostDiffs(tr, item);
    var td = fmtDiff(totalDiff);
    tr.appendChild(makeCell(td.text, {
      fontWeight: '500', color: td.color, className: 'diff-border', padding: '12px 12px'
    }));

    return tr;
  }

  /* ── Build a zone header row ── */
  function buildZoneHeader(zone) {
    var n = visibleCosts.length;
    var perSideCols = 3 + n + 1;
    var diffCols    = n + 1;

    var tr = document.createElement('tr');
    tr.className = 'zone-header-row';
    tr.style.background = '#EDECEA';

    var yourTd = el('td', {
      className: 'center-border',
      style: { padding: '8px 16px', fontWeight: '600', color: '#5F5E5A', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.5px', borderBottom: '1px solid var(--border-light)' }
    }, zone.yourName);
    yourTd.colSpan = perSideCols;

    var adjTd = el('td', {
      style: { padding: '8px 16px', fontWeight: '600', color: '#5F5E5A', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.5px', borderBottom: '1px solid var(--border-light)' }
    }, zone.adjusterName);
    adjTd.colSpan = perSideCols;

    var diffTd = el('td', {
      className: 'diff-border',
      style: { padding: '8px 12px', borderBottom: '1px solid var(--border-light)' }
    });
    diffTd.colSpan = diffCols;

    tr.appendChild(yourTd);
    tr.appendChild(adjTd);
    tr.appendChild(diffTd);
    return tr;
  }

  /* ── Compute zone aggregates ── */
  function computeZoneTotals(zone) {
    var yourTotal = 0, adjTotal = 0;
    var yourCosts = {}, adjCosts = {};
    visibleCosts.forEach(function (k) { yourCosts[k] = 0; adjCosts[k] = 0; });

    zone.items.forEach(function (item) {
      if (item.your && !item.your.totalDisplay) {
        yourTotal += item.your.total;
        visibleCosts.forEach(function (k) { yourCosts[k] += (item.your[k] || 0); });
      }
      if (item.adjuster) {
        adjTotal += item.adjuster.total;
        visibleCosts.forEach(function (k) { adjCosts[k] += (item.adjuster[k] || 0); });
      }
    });
    return { yourTotal: yourTotal, adjTotal: adjTotal, yourCosts: yourCosts, adjCosts: adjCosts };
  }

  /* ── Build a zone totals row ── */
  function buildZoneTotals(zone) {
    var tr = document.createElement('tr');
    tr.className = 'totals-row';

    var t = computeZoneTotals(zone);

    /* Your side */
    var yourLabel = makeCell('Totals: ' + zone.yourName, { padding: '14px 16px' });
    yourLabel.colSpan = 3;
    tr.appendChild(yourLabel);
    visibleCosts.forEach(function (k) {
      tr.appendChild(makeCell(fmtCostCell(t.yourCosts[k]), { align: 'right', fontWeight: '500' }));
    });
    tr.appendChild(makeCell(fmt(t.yourTotal), { align: 'right', fontWeight: '500', className: 'center-border', padding: '14px 12px' }));

    /* Adjuster side */
    var adjLabel = makeCell('Totals: ' + zone.adjusterName, { padding: '14px 16px' });
    adjLabel.colSpan = 3;
    tr.appendChild(adjLabel);
    visibleCosts.forEach(function (k) {
      tr.appendChild(makeCell(fmtCostCell(t.adjCosts[k]), { align: 'right', fontWeight: '500' }));
    });
    tr.appendChild(makeCell(fmt(t.adjTotal), { align: 'right', fontWeight: '500', padding: '14px 12px' }));

    /* Diff */
    visibleCosts.forEach(function (k) {
      var d = fmtDiff(t.adjCosts[k] - t.yourCosts[k]);
      tr.appendChild(makeCell(d.text, { align: 'right', fontWeight: '500', color: d.color, className: 'diff-border' }));
    });
    var dt = fmtDiff(t.adjTotal - t.yourTotal);
    tr.appendChild(makeCell(dt.text, { fontWeight: '500', color: dt.color, className: 'diff-border', padding: '14px 12px' }));

    return tr;
  }

  /* ── Grand totals row ── */
  function buildGrandTotals(data) {
    var tr = document.createElement('tr');
    tr.className = 'totals-row';
    tr.style.fontWeight = '600';

    var yourGrand = 0, adjGrand = 0;
    var yourCosts = {}, adjCosts = {};
    visibleCosts.forEach(function (k) { yourCosts[k] = 0; adjCosts[k] = 0; });

    data.zones.forEach(function (zone) {
      zone.items.forEach(function (item) {
        if (item.your && !item.your.totalDisplay) {
          yourGrand += item.your.total;
          visibleCosts.forEach(function (k) { yourCosts[k] += (item.your[k] || 0); });
        }
        if (item.adjuster) {
          adjGrand += item.adjuster.total;
          visibleCosts.forEach(function (k) { adjCosts[k] += (item.adjuster[k] || 0); });
        }
      });
    });

    /* Your side */
    var yourLabel = makeCell('Grand Total', { padding: '14px 16px', fontWeight: '700' });
    yourLabel.colSpan = 3;
    tr.appendChild(yourLabel);
    visibleCosts.forEach(function (k) {
      tr.appendChild(makeCell(fmtCostCell(yourCosts[k]), { align: 'right', fontWeight: '600' }));
    });
    tr.appendChild(makeCell(fmt(yourGrand), { align: 'right', fontWeight: '700', className: 'center-border', padding: '14px 12px' }));

    /* Adjuster side */
    var adjLabel = makeCell('Grand Total', { padding: '14px 16px', fontWeight: '700' });
    adjLabel.colSpan = 3;
    tr.appendChild(adjLabel);
    visibleCosts.forEach(function (k) {
      tr.appendChild(makeCell(fmtCostCell(adjCosts[k]), { align: 'right', fontWeight: '600' }));
    });
    tr.appendChild(makeCell(fmt(adjGrand), { align: 'right', fontWeight: '700', padding: '14px 12px' }));

    /* Diff */
    visibleCosts.forEach(function (k) {
      var d = fmtDiff(adjCosts[k] - yourCosts[k]);
      tr.appendChild(makeCell(d.text, { align: 'right', fontWeight: '600', color: d.color, className: 'diff-border' }));
    });
    var gd = fmtDiff(adjGrand - yourGrand);
    tr.appendChild(makeCell(gd.text, { fontWeight: '700', color: gd.color, className: 'diff-border', padding: '14px 12px' }));

    return tr;
  }

  /* ── Build the column labels header row ── */
  function buildColumnLabelsRow() {
    var tr = document.createElement('tr');
    tr.id = 'columnLabelsRow';
    tr.style.background = 'var(--bg-surface)';

    var hdrStyle = 'padding:7px 8px; font-weight:500; color:var(--text-secondary); font-size:11px; border-bottom:1px solid var(--border-default);';

    function hdr(text, extra, cls) {
      var td = document.createElement('td');
      td.setAttribute('style', hdrStyle + (extra || ''));
      td.textContent = text;
      if (cls) td.className = cls;
      return td;
    }

    /* Your side: Desc, Zone, Qty, [costs...], Total */
    tr.appendChild(hdr('Description', 'padding:7px 16px;'));
    tr.appendChild(hdr('Zone'));
    tr.appendChild(hdr('Qty', 'text-align:right;'));
    visibleCosts.forEach(function (key) {
      var col = currentData.costColumns.filter(function (c) { return c.key === key; })[0];
      tr.appendChild(hdr(col ? col.label : key, 'text-align:right;'));
    });
    tr.appendChild(hdr('Total', 'text-align:right;', 'center-border'));

    /* Adjuster side */
    tr.appendChild(hdr('Description', 'padding:7px 16px;'));
    tr.appendChild(hdr('Zone'));
    tr.appendChild(hdr('Qty', 'text-align:right;'));
    visibleCosts.forEach(function (key) {
      var col = currentData.costColumns.filter(function (c) { return c.key === key; })[0];
      tr.appendChild(hdr(col ? col.label : key, 'text-align:right;'));
    });
    tr.appendChild(hdr('Total', 'text-align:right;'));

    /* Diff area: [cost diffs...], Total diff */
    visibleCosts.forEach(function (key) {
      var col = currentData.costColumns.filter(function (c) { return c.key === key; })[0];
      tr.appendChild(hdr((col ? col.label : key) + ' \u0394', 'text-align:right;', 'diff-border'));
    });
    var diffTd = hdr('Diff', '', 'diff-border diff-sort');
    diffTd.innerHTML = '<span class="sort-arrow">\u2195</span>';
    tr.appendChild(diffTd);

    return tr;
  }

  /* ── Rebuild colgroup for current column count ── */
  function recalcLayout() {
    var n = visibleCosts.length;
    var costW = WIDTH.costCol;
    var perSideFixed = WIDTH.zone + WIDTH.qty + (n * costW) + WIDTH.total;
    var diffArea = (n * WIDTH.diffCost) + WIDTH.diffTotal;
    var desc = Math.max(5, (100 - 2 * perSideFixed - diffArea) / 2);

    var perSideCols = 3 + n + 1;
    var diffCols    = n + 1;

    var table = document.getElementById('comparisonTable');
    var colgroup = table.querySelector('colgroup');
    colgroup.innerHTML = '';

    function addCol(w) {
      var col = document.createElement('col');
      col.style.width = w + '%';
      colgroup.appendChild(col);
    }

    /* Your side: desc, zone, qty, [costs], total */
    addCol(desc);
    addCol(WIDTH.zone);
    addCol(WIDTH.qty);
    for (var i = 0; i < n; i++) addCol(costW);
    addCol(WIDTH.total);

    /* Adjuster side */
    addCol(desc);
    addCol(WIDTH.zone);
    addCol(WIDTH.qty);
    for (var j = 0; j < n; j++) addCol(costW);
    addCol(WIDTH.total);

    /* Diff area */
    for (var k = 0; k < n; k++) addCol(WIDTH.diffCost);
    addCol(WIDTH.diffTotal);

    /* Master header colspans */
    var masterRow = table.querySelector('thead tr:first-child');
    if (masterRow) {
      masterRow.children[0].colSpan = perSideCols;
      masterRow.children[1].colSpan = perSideCols;
      masterRow.children[2].colSpan = diffCols;
    }
  }

  /* ── Render the full table ── */
  function renderTable(data) {
    currentData = data;
    var table = document.getElementById('comparisonTable');
    var tbody = table.querySelector('tbody');
    var thead = table.querySelector('thead');
    tbody.innerHTML = '';

    /* Rebuild column labels in thead */
    var old = document.getElementById('columnLabelsRow');
    if (old) old.remove();
    thead.appendChild(buildColumnLabelsRow());

    /* Rebuild colgroup */
    recalcLayout();

    var totalCols = (3 + visibleCosts.length + 1) * 2 + visibleCosts.length + 1;

    /* Each zone */
    data.zones.forEach(function (zone, zi) {
      tbody.appendChild(buildZoneHeader(zone));
      zone.items.forEach(function (item) {
        tbody.appendChild(buildDataRow(item, zone));
      });
      tbody.appendChild(buildZoneTotals(zone));

      if (zi < data.zones.length - 1) {
        var spacer = document.createElement('tr');
        spacer.className = 'spacer-row';
        var std = document.createElement('td');
        std.colSpan = totalCols;
        spacer.appendChild(std);
        tbody.appendChild(spacer);
      }
    });

    /* Grand totals */
    var finalSpacer = document.createElement('tr');
    finalSpacer.className = 'spacer-row';
    var fstd = document.createElement('td');
    fstd.colSpan = totalCols;
    finalSpacer.appendChild(fstd);
    tbody.appendChild(finalSpacer);
    tbody.appendChild(buildGrandTotals(data));

    /* Reposition resize handle */
    if (window.positionResizeHandle) setTimeout(window.positionResizeHandle, 0);
  }

  /* ── Column Manager: dropdown UI ── */
  function initColumnManager(data) {
    var available = detectAvailableCosts(data);
    var panel = document.getElementById('columnsPanel');
    var btn   = document.getElementById('columnsToggleBtn');
    var badge = btn ? btn.querySelector('.columns-badge') : null;

    if (!panel || !btn) return;

    panel.innerHTML = '';
    available.forEach(function (col) {
      var label = document.createElement('label');
      label.style.cssText = 'display:flex; align-items:center; gap:6px; padding:8px 0; cursor:pointer; font-size:13px; color:var(--text-primary); white-space:nowrap;';

      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = col.key;
      cb.style.accentColor = 'var(--text-primary)';

      cb.addEventListener('change', function () {
        if (cb.checked) {
          if (visibleCosts.indexOf(col.key) < 0) visibleCosts.push(col.key);
        } else {
          visibleCosts = visibleCosts.filter(function (k) { return k !== col.key; });
        }
        renderTable(currentData);
        updateBadge();
        if (window.ComparisonFilters && ComparisonFilters.applyAll) ComparisonFilters.applyAll();
      });

      label.appendChild(cb);
      label.appendChild(document.createTextNode(col.label));
      panel.appendChild(label);
    });

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      panel.hidden = !panel.hidden;
      var fp = document.getElementById('filtersPanel');
      if (fp) fp.hidden = true;
    });

    document.addEventListener('click', function (e) {
      if (!panel.contains(e.target) && e.target !== btn) {
        panel.hidden = true;
      }
    });

    function updateBadge() {
      if (!badge) return;
      var n = visibleCosts.length;
      badge.textContent = n;
      badge.style.display = n > 0 ? '' : 'none';
    }
  }

  /* ── Public API ── */
  return {
    render: function (data) {
      currentData = data;
      renderTable(data);
      initColumnManager(data);
    },
    getVisibleCosts: function () { return visibleCosts.slice(); }
  };

})();
