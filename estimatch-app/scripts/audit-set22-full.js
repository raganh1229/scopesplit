/**
 * Full Set22 accuracy audit (cross-format Xactimate × Symbility).
 * Parses the cheatsheet, queries the DB, builds zone-level + item-level diffs.
 *
 * Usage: node scripts/audit-set22-full.js
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
require('dotenv').config({ path: '.env.local' });

const ID = '73041d34-503e-494d-8377-cf6f7be7c7c9';
const CHEAT = path.resolve(
  __dirname,
  '../../../scopesplit-testing/PDFS/Generated Sets/Set22/Set22_Cheatsheet.md'
);

// ── Cheatsheet parser ─────────────────────────────────────────────────────────
// Maps cheatsheet zone heading → canonical lowercase zone slug used in DB.
const ZONE_SLUG = {
  'General Conditions / Project Overhead & General Requirements': 'general conditions',
  'Roof & Exterior / Roofing System & Building Envelope':         'roof exterior',
  'Attic Space / Attic & Roof Structure Interior':                'attic space',
  'Master Bedroom / Primary Bedroom Suite':                       'master bedroom',
  'Living Room / Main Living & Great Room':                       'living room',
  'Kitchen / Kitchen & Breakfast Area':                           'kitchen',
  'Master Bathroom / Primary Bath Suite':                         'master bathroom',
  'Hall Bathroom / Secondary Bathroom':                           'hall bathroom',
  'Garage / Attached Garage':                                     'garage',
  'Hallway & Stairs / Upper Hallway and Staircase':               'hallway stairs',
};

function parseCheatsheet() {
  const text = fs.readFileSync(CHEAT, 'utf8');
  const lines = text.split('\n');
  const zones = {};
  let currentZone = null;

  for (const ln of lines) {
    const h = ln.match(/^### (.+?)\s*$/);
    if (h && ZONE_SLUG[h[1]]) {
      currentZone = ZONE_SLUG[h[1]];
      zones[currentZone] = { rows: [], counts: { MATCH: 0, 'MOD-QTY': 0, 'MOD-PRICE': 0, MISSING: 0, ADDED: 0 } };
      continue;
    }
    if (h && !ZONE_SLUG[h[1]]) currentZone = null;
    if (!currentZone) continue;
    if (!ln.startsWith('|')) continue;

    const cells = ln.split('|').map(s => s.trim());
    // | # | Sub-cat | C-desc | A-desc | Status | C$ | A$ | Gap | (8 cells + 2 outer empties)
    if (cells.length < 9) continue;
    const num = cells[1];
    if (!/^\d+$/.test(num)) continue; // skip header / divider rows

    const cDesc = cells[3];
    const aDesc = cells[4];
    const statusRaw = cells[5];
    const cDollar = cells[6];
    const aDollar = cells[7];
    const gap = cells[8];

    let status;
    if (/^MATCH/.test(statusRaw)) status = 'MATCH';
    else if (/MOD-QTY/.test(statusRaw)) status = 'MOD-QTY';
    else if (/MOD-PRICE/.test(statusRaw)) status = 'MOD-PRICE';
    else if (/MISSING/.test(statusRaw)) status = 'MISSING';
    else if (/ADDED/.test(statusRaw)) status = 'ADDED';
    else continue;

    zones[currentZone].counts[status]++;
    zones[currentZone].rows.push({
      num: parseInt(num, 10),
      cDesc: cDesc === '*(none)*' ? null : cDesc,
      aDesc: aDesc === '*(none)*' ? null : aDesc,
      status,
      statusRaw,
      cDollar,
      aDollar,
      gap,
    });
  }
  return zones;
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const cheat = parseCheatsheet();

  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  // P8 extraction (zone-level)
  const ext = await c.query(
    `SELECT z.source, z.name AS zone_name, COUNT(li.id)::int AS extracted_count
     FROM n3_zones z
     LEFT JOIN n3_line_items li ON li.zone_id = z.id
     WHERE z.comparison_id = $1
     GROUP BY z.id, z.source, z.name
     ORDER BY z.source, z.name`,
    [ID]
  );

  // Decision rows
  const li = await c.query(
    `SELECT
        COALESCE(zone_canonical, zone_yours, zone_adjuster) AS zone,
        match_status,
        description_yours,
        description_adjuster,
        total_yours,
        total_adjuster,
        diff_amount,
        sort_order
     FROM line_items
     WHERE comparison_id = $1
     ORDER BY zone, sort_order`,
    [ID]
  );

  const totals = await c.query(
    `SELECT
       COUNT(*)::int AS row_count,
       SUM(diff_amount)::numeric AS gap,
       SUM(total_yours)::numeric AS yours_total,
       SUM(total_adjuster)::numeric AS adj_total
     FROM line_items WHERE comparison_id = $1`,
    [ID]
  );

  await c.end();

  // ── Step 5: per-zone decision count diff ────────────────────────────────────
  console.log('═══ STEP 5: Per-zone decision count diff (cheatsheet vs DB) ═══\n');

  const dbStatus2cheat = {
    MATCH:                   ['MATCH'],
    MODIFIED:                ['MOD-QTY', 'MOD-PRICE'],
    MISSING_FROM_ADJUSTER:   ['MISSING'],
    ADDED_BY_ADJUSTER:       ['ADDED'],
  };

  const dbByZone = {};
  for (const r of li.rows) {
    const z = r.zone;
    if (!dbByZone[z]) dbByZone[z] = { MATCH: 0, MODIFIED: 0, MISSING_FROM_ADJUSTER: 0, ADDED_BY_ADJUSTER: 0, rows: [] };
    dbByZone[z][r.match_status]++;
    dbByZone[z].rows.push(r);
  }

  const zoneDiffs = [];
  for (const [slug, exp] of Object.entries(cheat)) {
    const db = dbByZone[slug] || { MATCH: 0, MODIFIED: 0, MISSING_FROM_ADJUSTER: 0, ADDED_BY_ADJUSTER: 0 };
    const expM = exp.counts.MATCH;
    const expMod = exp.counts['MOD-QTY'] + exp.counts['MOD-PRICE'];
    const expMis = exp.counts.MISSING;
    const expAdd = exp.counts.ADDED;
    const dM = db.MATCH - expM;
    const dMod = db.MODIFIED - expMod;
    const dMis = db.MISSING_FROM_ADJUSTER - expMis;
    const dAdd = db.ADDED_BY_ADJUSTER - expAdd;
    const flag = (dM || dMod || dMis || dAdd) ? '⚠️' : '✓';
    console.log(
      `${flag} ${slug.padEnd(22)} ` +
      `MATCH ${expM}→${db.MATCH}(${dM>=0?'+':''}${dM}) | ` +
      `MOD ${expMod}→${db.MODIFIED}(${dMod>=0?'+':''}${dMod}) | ` +
      `MIS ${expMis}→${db.MISSING_FROM_ADJUSTER}(${dMis>=0?'+':''}${dMis}) | ` +
      `ADD ${expAdd}→${db.ADDED_BY_ADJUSTER}(${dAdd>=0?'+':''}${dAdd})`
    );
    if (dM || dMod || dMis || dAdd) zoneDiffs.push(slug);
  }

  // ── Step 6: item-level diff for zones with discrepancies ────────────────────
  console.log('\n═══ STEP 6: Item-level diff for divergent zones ═══');
  if (zoneDiffs.length === 0) {
    console.log('No zone-level decision-count discrepancies. Pipeline matches cheatsheet exactly.');
  } else {
    for (const slug of zoneDiffs) {
      console.log(`\n── ${slug} ──`);
      const expRows = cheat[slug].rows;
      const dbRows = dbByZone[slug].rows;

      console.log(`  Expected ${expRows.length} cheatsheet rows; DB returned ${dbRows.length} rows.`);

      // For each cheatsheet row, find its DB counterpart by matching on description.
      const dbUsed = new Set();
      const misclass = [];
      for (const er of expRows) {
        // Build a search key based on whichever description is present.
        let match = null;
        for (let i = 0; i < dbRows.length; i++) {
          if (dbUsed.has(i)) continue;
          const dr = dbRows[i];
          const cMatch = er.cDesc && dr.description_yours && dr.description_yours.trim() === er.cDesc.trim();
          const aMatch = er.aDesc && dr.description_adjuster && dr.description_adjuster.trim() === er.aDesc.trim();
          // For MATCH/MOD: both descs should align.
          // For MISSING: only cDesc.  For ADDED: only aDesc.
          if (er.status === 'MISSING' && cMatch && !dr.description_adjuster) { match = i; break; }
          if (er.status === 'ADDED' && aMatch && !dr.description_yours)      { match = i; break; }
          if ((er.status === 'MATCH' || er.status === 'MOD-QTY' || er.status === 'MOD-PRICE') && cMatch && aMatch) { match = i; break; }
        }
        // Fallback: best-effort match on either side
        if (match === null) {
          for (let i = 0; i < dbRows.length; i++) {
            if (dbUsed.has(i)) continue;
            const dr = dbRows[i];
            const cMatch = er.cDesc && dr.description_yours && dr.description_yours.trim() === er.cDesc.trim();
            const aMatch = er.aDesc && dr.description_adjuster && dr.description_adjuster.trim() === er.aDesc.trim();
            if (cMatch || aMatch) { match = i; break; }
          }
        }
        if (match === null) {
          misclass.push({ kind: 'no-db-row', expected: er, got: null });
          continue;
        }
        dbUsed.add(match);
        const dr = dbRows[match];
        const expectedDb =
          er.status === 'MATCH' ? 'MATCH' :
          (er.status === 'MOD-QTY' || er.status === 'MOD-PRICE') ? 'MODIFIED' :
          er.status === 'MISSING' ? 'MISSING_FROM_ADJUSTER' :
          er.status === 'ADDED' ? 'ADDED_BY_ADJUSTER' : null;
        if (dr.match_status !== expectedDb) {
          misclass.push({ kind: 'wrong-status', expected: er, got: dr });
        }
      }

      // Any DB rows not matched to a cheatsheet row?
      for (let i = 0; i < dbRows.length; i++) {
        if (!dbUsed.has(i)) {
          misclass.push({ kind: 'extra-db-row', expected: null, got: dbRows[i] });
        }
      }

      if (misclass.length === 0) {
        console.log('  All rows align with cheatsheet (count diff must be at row-pairing level — re-investigate).');
      } else {
        for (const m of misclass) {
          if (m.kind === 'wrong-status') {
            console.log(`  ❌ row #${m.expected.num} expected=${m.expected.status} got=${m.got.match_status}`);
            console.log(`     C: "${(m.expected.cDesc || '*(none)*').slice(0,70)}"  vs DB.yours: "${(m.got.description_yours||'').slice(0,70)}"`);
            console.log(`     A: "${(m.expected.aDesc || '*(none)*').slice(0,70)}"  vs DB.adj:   "${(m.got.description_adjuster||'').slice(0,70)}"`);
            console.log(`     $ DB: yours=${m.got.total_yours} adj=${m.got.total_adjuster} diff=${m.got.diff_amount}`);
          } else if (m.kind === 'no-db-row') {
            console.log(`  ❌ row #${m.expected.num} (${m.expected.status}) has NO matching DB row`);
            console.log(`     C: "${(m.expected.cDesc || '*(none)*').slice(0,70)}"`);
            console.log(`     A: "${(m.expected.aDesc || '*(none)*').slice(0,70)}"`);
          } else if (m.kind === 'extra-db-row') {
            const dr = m.got;
            console.log(`  ❌ EXTRA DB row (no cheatsheet match) status=${dr.match_status}`);
            console.log(`     DB.yours: "${(dr.description_yours||'').slice(0,70)}"`);
            console.log(`     DB.adj:   "${(dr.description_adjuster||'').slice(0,70)}"`);
            console.log(`     $ yours=${dr.total_yours} adj=${dr.total_adjuster} diff=${dr.diff_amount}`);
          }
        }
      }
    }
  }

  // ── Totals ──────────────────────────────────────────────────────────────────
  console.log('\n═══ TOTALS ═══');
  console.table(totals.rows);

  // ── Cheatsheet expected totals
  let tMATCH=0, tMOD=0, tMIS=0, tADD=0;
  for (const z of Object.values(cheat)) {
    tMATCH += z.counts.MATCH;
    tMOD   += z.counts['MOD-QTY'] + z.counts['MOD-PRICE'];
    tMIS   += z.counts.MISSING;
    tADD   += z.counts.ADDED;
  }
  console.log(`\nCheatsheet totals: MATCH=${tMATCH} MOD=${tMOD} MIS=${tMIS} ADD=${tADD} (rows=${tMATCH+tMOD+tMIS+tADD})`);

  // ── Extraction diff ─────────────────────────────────────────────────────────
  console.log('\n═══ Extraction (P8) ═══');
  const expExt = {
    yours: {
      'general conditions': 12, 'roof & exterior': 37, 'attic space': 22,
      'master bedroom': 28, 'living room': 24, 'kitchen': 22,
      'master bathroom': 18, 'hall bathroom': 14, 'garage': 14,
      'hallway & stairs': 11,
    },
    adjuster: {
      'floorplan: project overhead & general requirements': 12,
      'roofplan: roofing system & building envelope':       37,
      'floorplan: attic & roof structure interior':         22,
      'floorplan: primary bedroom suite':                   30,
      'floorplan: main living & great room':                25,
      'floorplan: kitchen & breakfast area':                22,
      'floorplan: primary bath suite':                      18,
      'floorplan: secondary bathroom':                      13,
      'floorplan: attached garage':                         14,
      'floorplan: upper hallway and staircase':             11,
    },
  };
  for (const r of ext.rows) {
    const exp = expExt[r.source][r.zone_name.toLowerCase()];
    const delta = r.extracted_count - (exp ?? 0);
    const flag = (exp == null) ? '?' : delta === 0 ? '✓' : '⚠️';
    console.log(`${flag} ${r.source.padEnd(8)} ${r.zone_name.padEnd(55)} expected=${exp ?? '?'} extracted=${r.extracted_count} delta=${delta}`);
  }
})().catch(e => { console.error(e); process.exit(1); });
