/* ============================================================
   Mock Estimate Data — multi-zone comparison results
   
   This file simulates the output of AI-analyzed PDF estimates.
   Structure mirrors what the real pipeline will produce:
   matched/compared line items grouped by zone, with full
   cost breakdowns (remove, replace, reset, tax, op).
   ============================================================ */

var MockEstimateData = {

  meta: {
    yourFile: 'Fire_Damage_Example.pdf',
    adjusterFile: 'MONTAUK_Estimate.pdf'
  },

  /* Cost column definitions — order matters for display */
  costColumns: [
    { key: 'remove',  label: 'Remove'  },
    { key: 'replace', label: 'Replace' },
    { key: 'reset',   label: 'Reset'   },
    { key: 'tax',     label: 'Tax'     },
    { key: 'op',      label: 'O&P'     }
  ],

  zones: [

    /* ──────────────────────────────────────────────
       ZONE: General
       ────────────────────────────────────────────── */
    {
      id: 'general',
      yourName: 'General Items',
      adjusterName: 'General',
      items: [
        {
          status: 'match', category: 'debris-removal',
          your:     { description: 'Dumpster load - Approx. 30 yards, 5-7 tons of debris', qty: '1.00 EA', remove: 0, replace: 877.20, reset: 0, tax: 0, op: 0, total: 877.20 },
          adjuster: { description: 'Dumpster load - Approx. 20 yards, 4 tons of debris',   qty: '1.00 EA', remove: 0, replace: 881.17, reset: 0, tax: 0, op: 0, total: 881.17 }
        },
        {
          status: 'missing', category: 'labor',
          your:     { description: 'General Laborer - per hour', qty: '8.00 HR', remove: 0, replace: 457.06, reset: 0, tax: 0, op: 0, total: 457.06 },
          adjuster: null
        },
        {
          status: 'modified', category: 'supervision',
          your:     { description: 'Residential Supervision / Project Management - per hour', qty: '180.00 HR', remove: 0, replace: 16860.96, reset: 0, tax: 0, op: 0, total: 16860.96 },
          adjuster: { description: 'Residential Supervision / Project Management - per hour', qty: '16.00 HR',  remove: 0, replace: 1740.02,  reset: 0, tax: 0, op: 0, total: 1740.02 }
        },
        {
          status: 'missing', category: 'permits',
          your:     { description: 'PERMITS AND FEES', qty: '1.00 EA', remove: 0, replace: 0, reset: 0, tax: 0, op: 0, total: 0, totalDisplay: 'OPEN' },
          adjuster: null
        },
        {
          status: 'match', category: 'electrical',
          your:     { description: 'R&R Temporary power - overhead hookup',  qty: '1.00 EA',   remove: 152.45, replace: 457.35, reset: 152.46, tax: 0,    op: 0,     total: 762.26 },
          adjuster: { description: 'Floor protection - plastic and tape - 10 mil', qty: '250.00 SF', remove: 0,      replace: 106.89, reset: 0,      tax: 8.55, op: 18.17, total: 133.61 }
        },
        {
          status: 'missing', category: 'electrical',
          your:     { description: 'Temporary power usage (per month)', qty: '6.00 MO', remove: 0, replace: 1910.41, reset: 0, tax: 0, op: 0, total: 1910.41 },
          adjuster: null
        },
        {
          status: 'missing', category: 'general-conditions',
          your:     { description: 'Temporary toilet (per month)', qty: '6.00 MO', remove: 0, replace: 1162.80, reset: 0, tax: 0, op: 0, total: 1162.80 },
          adjuster: null
        },
        {
          status: 'added', category: 'cleaning',
          your:     null,
          adjuster: { description: 'Cleaning Technician - per hour - general', qty: '8.00 HR', remove: 0, replace: 387.17, reset: 0, tax: 0, op: 96.79, total: 483.96 }
        },
        {
          status: 'added', category: 'electrical',
          your:     null,
          adjuster: { description: 'Megohmmeter check electrical circuits - average residence', qty: '1.00 EA', remove: 0, replace: 1281.26, reset: 0, tax: 102.72, op: 217.59, total: 1601.57 }
        }
      ]
    },

    /* ──────────────────────────────────────────────
       ZONE: Kitchen
       ────────────────────────────────────────────── */
    {
      id: 'kitchen',
      yourName: 'Kitchen',
      adjusterName: 'Kitchen',
      items: [
        {
          status: 'modified', category: 'cabinetry',
          your:     { description: 'R&R Base cabinets - wood - 30 linear feet',  qty: '30.00 LF', remove: 450.00, replace: 3150.00, reset: 0, tax: 252.00, op: 398.00, total: 4250.00 },
          adjuster: { description: 'R&R Base cabinets - economy grade - 30 LF',  qty: '30.00 LF', remove: 300.00, replace: 2100.00, reset: 0, tax: 168.00, op: 232.00, total: 2800.00 }
        },
        {
          status: 'missing', category: 'countertops',
          your:     { description: 'Countertop - Granite slab - standard grade', qty: '45.00 SF', remove: 185.00, replace: 2450.50, reset: 0, tax: 196.04, op: 293.96, total: 3125.50 },
          adjuster: null
        },
        {
          status: 'match', category: 'flooring',
          your:     { description: 'Flooring - Ceramic tile - standard grade', qty: '120.00 SF', remove: 0, replace: 1512.00, reset: 0, tax: 120.96, op: 257.04, total: 1890.00 },
          adjuster: { description: 'Flooring - Ceramic tile - standard grade', qty: '120.00 SF', remove: 0, replace: 1536.00, reset: 0, tax: 122.88, op: 261.12, total: 1920.00 }
        },
        {
          status: 'added', category: 'appliances',
          your:     null,
          adjuster: { description: 'R&R Dishwasher - built-in - standard', qty: '1.00 EA', remove: 85.00, replace: 340.00, reset: 0, tax: 27.20, op: 32.80, total: 485.00 }
        },
        {
          status: 'modified', category: 'painting',
          your:     { description: 'Painting walls &amp; ceiling - two coats', qty: '450.00 SF', remove: 0, replace: 960.00, reset: 0, tax: 48.00, op: 192.00, total: 1200.00 },
          adjuster: { description: 'Painting walls &amp; ceiling - two coats', qty: '450.00 SF', remove: 0, replace: 700.00, reset: 0, tax: 35.00, op: 140.00, total: 875.00 }
        }
      ]
    },

    /* ──────────────────────────────────────────────
       ZONE: Bathroom
       ────────────────────────────────────────────── */
    {
      id: 'bathroom',
      yourName: 'Bathroom - Main',
      adjusterName: 'Bathroom',
      items: [
        {
          status: 'match', category: 'plumbing',
          your:     { description: 'R&R Toilet - standard grade', qty: '1.00 EA', remove: 95.00, replace: 285.50, reset: 85.00, tax: 0, op: 20.00, total: 485.50 },
          adjuster: { description: 'R&R Toilet - standard grade', qty: '1.00 EA', remove: 95.00, replace: 285.50, reset: 85.00, tax: 0, op: 20.00, total: 485.50 }
        },
        {
          status: 'modified', category: 'flooring',
          your:     { description: 'Tile - Floor ceramic 12x12 - thin set', qty: '85.00 SF', remove: 210.00, replace: 1155.00, reset: 0, tax: 92.40,  op: 192.60, total: 1650.00 },
          adjuster: { description: 'Tile - Floor ceramic 12x12 - thin set', qty: '85.00 SF', remove: 125.00, replace: 685.00,  reset: 0, tax: 54.80,  op: 115.20, total: 980.00 }
        },
        {
          status: 'missing', category: 'cabinetry',
          your:     { description: 'Vanity with countertop - cultured marble', qty: '1.00 EA', remove: 145.00, replace: 1425.00, reset: 0, tax: 114.00, op: 191.00, total: 1875.00 },
          adjuster: null
        },
        {
          status: 'match', category: 'plumbing',
          your:     { description: 'R&R Plumbing fixtures - standard grade', qty: '1.00 EA', remove: 120.00, replace: 385.00, reset: 135.00, tax: 30.80, op: 49.20, total: 720.00 },
          adjuster: { description: 'R&R Plumbing fixtures - standard grade', qty: '1.00 EA', remove: 115.00, replace: 370.00, reset: 130.00, tax: 29.60, op: 50.40, total: 695.00 }
        }
      ]
    }

  ]
};
